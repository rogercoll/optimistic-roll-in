// SPDX-License-Identifier: MIT

pragma solidity >=0.6.0 <=0.7.3;
pragma experimental ABIEncoderV2;

import "../node_modules/merkle-trees/eth/contracts/libraries/calldata/bytes/standard/merkle-library.sol";
import "./some-logic-contract.sol";

contract Optimistic_Roll_In {
  event New_Optimistic_State(address indexed user, uint256 indexed block_time);
  event New_Optimistic_States(address indexed user, uint256 indexed block_time);
  event Locked(address indexed suspect, address indexed accuser);
  event Unlocked(address indexed suspect, address indexed accuser);
  event Fraud_Proven(
    address indexed accuser,
    address indexed suspect,
    uint256 indexed transition_index,
    uint256 amount
  );
  event Rolled_Back(address indexed user, uint256 indexed tree_size, uint256 indexed block_time);
  event Exited_Optimism(address indexed user);

  address public immutable logic_address;

  mapping(address => uint256) public balances;
  mapping(address => bytes32) public account_states;
  mapping(address => address) public lockers;
  mapping(address => uint256) public locked_times;
  mapping(address => uint256) public rollback_sizes;

  constructor(address _logic_address) {
    logic_address = _logic_address;
  }

  receive() external payable {
    bond(msg.sender);
  }

  // Bonds msg.value, and reverts if resulting balance less than 1 ETH
  function bond(address user) public payable {
    uint256 amount = msg.value;

    if (amount == 0) {
      require(balances[user] >= 1000000000000000000, "INSUFFICIENT_BOND");
      return;
    }

    balances[user] += amount;
    require(balances[user] >= 1000000000000000000, "INSUFFICIENT_BOND");
  }

  // Sets user's account state to starting point, and bonds msg.value
  function initialize() external payable {
    address user = msg.sender;
    bond(user);

    require(account_states[user] == bytes32(0), "ALREADY_INITIALIZED");

    // Set account state to combination of empty call data tree, zero current state (S_0), and last time of 0 (not in optimism)
    account_states[user] = keccak256(abi.encodePacked(bytes32(0), bytes32(0), bytes32(0)));
  }

  // Allows unbonding of ETH if account not locked
  function withdraw(address payable destination) public {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    uint256 amount = balances[user];
    balances[user] = 0;
    destination.transfer(amount);
  }

  // Returns true if calling the logic contract with the call data results in new state
  function verify_transition(bytes calldata call_data, bytes32 new_state) internal returns (bool) {
    // Compute a new state
    (bool success, bytes memory state_bytes) = logic_address.call(call_data);

    if (!success) return false;

    // Decode new state from returns bytes, reusing the state variable
    bytes32 state = abi.decode(state_bytes, (bytes32));

    return state == new_state;
  }

  // Set the account state to the on-chain computed new state, if the account is not locked
  function perform(bytes calldata call_data) external payable {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Extract current state (S_0) from calldata (32 bytes starting after the function signature)
    bytes32 state = abi.decode(call_data[4:], (bytes32));

    // Check that the user it not in an optimistic state, which means that their account state is
    // an empty call data tree, current state (S_0), and the last block is 0
    require(keccak256(abi.encodePacked(bytes32(0), state, bytes32(0))) == account_states[user], "INVALID_ROOTS");

    // Compute a new state (S_1)
    (bool success, bytes memory state_bytes) = logic_address.call{ value: msg.value }(call_data);
    require(success, "CALL_FAILED");

    // Decode new state (S_1) from returned bytes, reusing the state variable
    state = abi.decode(state_bytes, (bytes32));

    // Set the account state to an empty call data tree, the new state (S_1), and last time 0
    account_states[user] = keccak256(abi.encodePacked(bytes32(0), state, bytes32(0)));
  }

  // Exits optimism by setting the account state to the on-chain computed new state, if the account is not locked
  function perform_and_exit(
    bytes calldata call_data,
    bytes32 call_data_root,
    uint256 last_time
  ) external payable {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");
    require(rollback_sizes[user] == 0, "ROLLBACK_REQUIRED");

    // Extract current state (S_n) from call data (32 bytes starting after the function signature)
    bytes32 state = abi.decode(call_data[4:], (bytes32));

    // Check that the call data root, current state (S_n), and last time are valid for this user
    require(
      keccak256(abi.encodePacked(call_data_root, state, bytes32(last_time))) == account_states[user],
      "INVALID_ROOTS"
    );

    // Check that enough time has elapsed for potential fraud proofs (10 minutes)
    require(last_time + 600 < block.timestamp, "INSUFFICIENT_TIME");

    // Compute a new state (S_n+1)
    (bool success, bytes memory state_bytes) = logic_address.call{ value: msg.value }(call_data);
    require(success, "CALL_FAILED");

    // Decode new state (S_n+1) from returned bytes, reusing the state variable
    state = abi.decode(state_bytes, (bytes32));

    // Set the account state to an empty call data tree, the new state (S_n+1), and last time 0
    // Since this is an exit of optimism, this new state (S_n+1) is now the zero state (S_0)
    account_states[user] = keccak256(abi.encodePacked(bytes32(0), state, bytes32(0)));

    emit Exited_Optimism(user);
  }

  // Enters optimism by updating the account state optimistically with call data and a new state, if the account is not locked
  function perform_optimistically_and_enter(
    bytes calldata call_data,
    bytes32 new_state,
    bytes32[] calldata proof
  ) external {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Extract current state (S_0) from call data (32 bytes starting after the function signature)
    bytes32 state = abi.decode(call_data[4:], (bytes32));

    // Check that the user it not in an optimistic state, which means that their account state is
    // an empty call data tree, current state (S_0), and the last block is 0
    require(keccak256(abi.encodePacked(bytes32(0), state, bytes32(0))) == account_states[user], "INVALID_ROOTS");

    // Get root of new merkle tree with 1 call data element (CD_0), reusing state as call_data_root
    state = Merkle_Library_CBS.try_append_one(bytes32(0), call_data, proof);

    // Combine call data root, new state (S_1), and current time into account state
    account_states[user] = keccak256(abi.encodePacked(state, new_state, bytes32(block.timestamp)));

    emit New_Optimistic_State(user, block.timestamp);
  }

  // Updates the account state optimistically with call data and a new state, if the account is not locked
  function perform_optimistically(
    bytes calldata call_data,
    bytes32 new_state,
    bytes32 call_data_root,
    bytes32[] calldata proof,
    uint256 last_time
  ) external {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Extract current state (S_n) from call data (32 bytes starting after the function signature)
    bytes32 state = abi.decode(call_data[4:], (bytes32));

    // Check that the call data root, current state (S_n), and last time are valid for this user
    require(
      keccak256(abi.encodePacked(call_data_root, state, bytes32(last_time))) == account_states[user],
      "INVALID_ROOTS"
    );

    // Get new merkle root of call data tree, appending call data (CD_n), reusing state as call_data_root
    state = Merkle_Library_CBS.try_append_one(call_data_root, call_data, proof);

    // Combine call data root, new state (S_n+1), and current time into account state
    account_states[user] = keccak256(abi.encodePacked(state, new_state, bytes32(block.timestamp)));

    emit New_Optimistic_State(user, block.timestamp);
  }

  // Enters optimism by updating the account state optimistically with several call data and final state, if the account is not locked
  function perform_many_optimistically_and_enter(
    bytes[] calldata call_data,
    bytes32 new_state,
    bytes32[] calldata proof
  ) external {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Check that there is more than 1 call data (if not, user should have called perform_optimistically_and_enter)
    require(call_data.length > 1, "INSUFFICIENT_CALLDATA");

    // Extract current state (S_0) from first call data (32 bytes starting after the function signature)
    bytes32 state = abi.decode(call_data[0][4:], (bytes32));

    // Check that the user it not in an optimistic state, which means that their account state is
    // an empty call data tree, current state (S_0), and the last block is 0
    require(keccak256(abi.encodePacked(bytes32(0), state, bytes32(0))) == account_states[user], "INVALID_ROOTS");

    // Get root of new merkle tree with several call data elements (CD_0 - CD_n-1), reusing state as call_data_root
    state = Merkle_Library_CBS.try_append_many(bytes32(0), call_data, proof);

    // Combine call data root, new state (S_n), and current time into account state
    account_states[user] = keccak256(abi.encodePacked(state, new_state, bytes32(block.timestamp)));

    emit New_Optimistic_States(user, block.timestamp);
  }

  // Updates the account state optimistically with several call data and final state, if the account is not locked
  function perform_many_optimistically(
    bytes[] calldata call_data,
    bytes32 new_state,
    bytes32 call_data_root,
    bytes32[] calldata proof,
    uint256 last_time
  ) external {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Check that there is more than 1 call data (if not, user should have called perform_optimistically)
    require(call_data.length > 1, "INSUFFICIENT_CALLDATA");

    // Extract current state (S_n) from first call data (32 bytes starting after the function signature)
    bytes32 state = abi.decode(call_data[0][4:], (bytes32));

    // Check that the call data root, current state (S_n), and last time are valid for this user
    require(
      keccak256(abi.encodePacked(call_data_root, state, bytes32(last_time))) == account_states[user],
      "INVALID_ROOTS"
    );

    // Get new merkle root of call data tree, appending several call data (CD_n - CD_n+m), reusing state as call_data_root
    state = Merkle_Library_CBS.try_append_many(call_data_root, call_data, proof);

    // Combine call data root, new state (S_n+m), and current time into account state
    account_states[user] = keccak256(abi.encodePacked(state, new_state, bytes32(block.timestamp)));

    emit New_Optimistic_States(user, block.timestamp);
  }

  // Lock two users (suspect and accuser)
  function lock_user(address suspect) external payable {
    address accuser = msg.sender;

    // The accuser and the suspect cannot already be locked
    // Note: This might have to be changed so a single accuser isn't overwhelmed with fraud
    require(lockers[accuser] == address(0), "ACCUSER_LOCKED");
    require(lockers[suspect] == address(0), "SUSPECT_LOCKED");

    // Lock both the accuser and the suspect
    lockers[suspect] = accuser;
    locked_times[suspect] = block.timestamp;
    lockers[accuser] = accuser;
    locked_times[accuser] = block.timestamp;

    // The accuser may be trying to bond at the same time (this also check that have enough bonded)
    bond(accuser);

    emit Locked(suspect, accuser);
  }

  // Unlock two users (suspect and accuser)
  function unlock(
    address suspect,
    bytes32 state,
    bytes32 call_data_root,
    uint256 last_time
  ) external {
    // Can only unlock a locked account if enough time has passed, and rollback not required
    require(lockers[suspect] != address(0), "ALREADY_UNLOCKED");
    require(locked_times[suspect] + 600 <= block.timestamp, "INSUFFICIENT_WINDOW");
    require(rollback_sizes[suspect] == 0, "REQUIRES_ROLLBACK");

    // Check that the call data root, current state (S_n), and last time are valid for this user
    require(
      keccak256(abi.encodePacked(call_data_root, state, bytes32(last_time))) == account_states[suspect],
      "INVALID_ROOTS"
    );

    // Unlock both accounts
    address accuser = lockers[suspect];
    lockers[suspect] = address(0);
    locked_times[suspect] = 0;
    lockers[accuser] = address(0);
    locked_times[accuser] = 0;

    // Give the suspect the accuser's bond for having not proven fraud within a reasonable time frame
    // TODO: consider burning some here to prevent self-reporting breakeven
    uint256 amount = balances[accuser];
    balances[accuser] = 0;
    balances[suspect] += amount;

    // Combine call data root, current state (S_n), and current time into account state
    // Note: updating last time is important, to prevent user blocking fraud proofs by locking themselves
    account_states[suspect] = keccak256(abi.encodePacked(call_data_root, state, bytes32(block.timestamp)));

    emit Unlocked(suspect, accuser);
  }

  // Reward accuser for proving fraud in a suspect's transition, and track the expected rolled back account state size
  function prove_fraud(
    address suspect,
    bytes[] calldata call_data,
    bytes32 state,
    bytes32 call_data_root,
    bytes32[] calldata proof,
    uint256 last_time
  ) external {
    address accuser = msg.sender;

    // Only the user that flagged/locked the suspect can prove fraud
    require(lockers[suspect] == accuser, "NOT_LOCKER");

    // Check that the call data root, current state (S_n), and last time are valid for this user
    require(
      keccak256(abi.encodePacked(call_data_root, state, bytes32(last_time))) == account_states[suspect],
      "INVALID_ROOTS"
    );

    // Check that the call data exist
    require(Merkle_Library_CBS.elements_exist(call_data_root, call_data, proof), "INVALID_CALLDATA");

    // get the indices of the call data in the call data tre
    uint256[] memory call_data_indices = Merkle_Library_CBS.get_indices(call_data, proof);

    // The transition index is the index of the starting call data of the fraud proof
    uint256 transition_index = call_data_indices[0];

    // If only one call data is provided, the fraud involves the last call data and current state
    if (call_data.length == 1) {
      // Check that the call data index is the last (call data tree size minus 1)
      require(transition_index + 1 == uint256(proof[0]), "INCORRECT_CALLDATA");

      // Fail if the state transition was valid
      require(verify_transition(call_data[0], state) == false, "VALID_TRANSITION");
    } else {
      // Check that call data provided are consecutive
      require(transition_index + 1 == call_data_indices[1]);

      // Extract new state from second call data (32 bytes starting after the function signature), reusing state var
      state = abi.decode(call_data[1][4:], (bytes32));

      // Fail if the state transition was valid
      require(verify_transition(call_data[0], state) == false, "VALID_TRANSITION");
    }

    // Take the suspect's bond and give it to the accuser, reusing last_time var
    // TODO: consider burning some here to prevent self-reporting breakeven
    last_time = balances[suspect];
    balances[suspect] = 0;
    balances[accuser] += last_time;

    // Unlock the accuser's account
    lockers[accuser] = address(0);
    locked_times[accuser] = 0;

    // Set the rollback size to the amount of elements that should be in the call data tree once rolled back
    rollback_sizes[suspect] = transition_index;

    // Set the suspect as the reason for their account's lock
    lockers[suspect] = suspect;
    locked_times[suspect] = 0;

    emit Fraud_Proven(accuser, suspect, transition_index, last_time);
  }

  // Rolls a user back, given the current roots, old roots, and a proof of the optimistic transitions between them
  function rollback(
    bytes32 rolled_back_call_data_root,
    bytes[] calldata rolled_back_call_data,
    bytes32[] calldata roll_back_proof,
    uint256 current_size,
    bytes32 current_size_proof,
    bytes32 call_data_root,
    bytes32 state,
    uint256 last_time
  ) external payable {
    address user = msg.sender;
    uint256 expected_size = rollback_sizes[user];
    require(expected_size != 0, "ROLLBACK_UNNECESSARY");

    // Check that the call data root, current state (S_n), and last time are valid for this user
    require(
      keccak256(abi.encodePacked(call_data_root, state, bytes32(last_time))) == account_states[user],
      "INVALID_ROOTS"
    );

    // Check that the provided size of the current call data tree is correct
    require(Merkle_Library_CBS.verify_size(call_data_root, current_size, current_size_proof), "INVALID_SIZE");

    // Allow incremental roll back by checking that the rolled back call data tree is smaller than the current tree
    uint256 rolled_back_size = uint256(roll_back_proof[0]);
    require(rolled_back_size < current_size, "INSUFFICIENT_ROLLBACK");

    // Check that this is not rolling back too far, though
    require(rolled_back_size >= expected_size, "ROLLBACK_TOO_DEEP");

    // Check that the current call data root is derived by appending the rolled back call data to the rolled back call data root
    require(
      Merkle_Library_CBS.try_append_many(rolled_back_call_data_root, rolled_back_call_data, roll_back_proof) ==
        call_data_root,
      "INVALID_ROLLBACK"
    );

    // Extract new state from first rolled back call data (32 bytes starting after the function signature), reusing state var
    state = abi.decode(rolled_back_call_data[0][4:], (bytes32));

    // Combine rolled back call data root, new state (S_n-m), and current time into account state
    account_states[user] = keccak256(abi.encodePacked(rolled_back_call_data_root, state, bytes32(block.timestamp)));

    // Unlock the user and clear the rollback flag, if roll back is complete
    if (rolled_back_size == expected_size) {
      lockers[user] = address(0);
      rollback_sizes[user] = 0;
    }

    // The user may be trying to bond at the same time (this also check that have enough bonded)
    bond(user);

    emit Rolled_Back(user, rolled_back_size, block.timestamp);
  }
}
