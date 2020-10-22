const assert = require('assert');
const { MerkleTree, PartialMerkleTree } = require('merkle-trees/js');
const txDecoder = require('ethereum-tx-decoder');

const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('./utils');

const proofOptions = { compact: true, simple: true };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ORI_Fraud_Proven = '0xa66290bc21cee2ba1a3c6ba2cac21d24511cea1f9ed7efe453736f24fd894886';
const ORI_Locked = '0x8773bde6581ad6ddd421210de867340039fb65ce3df41edba7b5de6d24ae7a51';
const ORI_New_Optimistic_State = '0x4779c4b07abff82b16061ec9a47d081e7f4981c29088395cdb7ff87e322cbbc6';
const ORI_New_Optimistic_States = '0x0b87b136840d19f5f25329273082c00833265a189b70137e06df6315ddc7839e';
const ORI_New_State = '0x0f5025cc4f20aa47a346d1b7d9da6ba8c68cc8e83b75e813da4b4490d55365ae';
const ORI_Rolled_Back = '0x4d7ed8c49e6b03daee23a18f4bd14bd7e4628e5ed54c57bf84407a693867eca9';
const ORI_Unlocked = '0x524512344e535e9bda79e916c2ea8c7b9e5d23d83e1b95181d7622b4ac3d4293';

class OptimisticRollIn {
  constructor(oriInstance, logicInstance, accountAddress, options = {}) {
    const {
      sourceAddress = accountAddress,
      treeOptions = {},
      optimismDecoder,
      logicDecoder,
      web3,
      parentORI,
    } = options;

    const { elementPrefix = '00' } = treeOptions;

    assert(web3, 'web3 option is mandatory for now.');

    this._web3 = web3;

    this._parentORI = parentORI;

    this._treeOptions = { unbalanced: true, sortedHash: false, elementPrefix };

    this._oriContractInstance = oriInstance;
    this._logicContractInstance = logicInstance;

    logicInstance.abi.forEach(({ name, type, signature, stateMutability }) => {
      if (type !== 'function') return;

      const functionSet = { normal: (args, options) => this._pessimisticCall(name, args, options) };

      if (stateMutability === 'pure' || stateMutability === 'view') {
        Object.assign(functionSet, {
          optimistic: (args, newState) => this._optimisticCall(name, args, newState),
          queue: (args, newState) => this._queueCall(name, args, newState),
        });
      }

      Object.assign(this, { [name]: functionSet });
    });

    this._optimismDecoder = optimismDecoder ?? new txDecoder.FunctionDecoder(oriInstance.abi);
    this._logicDecoder = logicDecoder ?? new txDecoder.FunctionDecoder(logicInstance.abi);

    this._sourceAddress = sourceAddress;

    this._state = {
      user: accountAddress,
      callDataTree: null,
      currentState: null,
      lastTime: null,
      fraudIndex: null,
    };

    this._queue = {
      newStates: [],
      functionNames: [],
      args: [],
    };

    this._frauds = {};
  }

  // STATIC: Creates a new OptimisticRollIn instance, with defined parameters and options
  static fraudsterFromProof(parameters = {}, options = {}) {
    const { suspect, fraudIndex, callDataArrayHex, newStateHex, proofHex, lastTime } = parameters;

    const {
      oriInstance,
      logicInstance,
      functions,
      sourceAddress,
      treeOptions = { elementPrefix: '00' },
      optimismDecoder,
      logicDecoder,
      web3,
      parentORI,
    } = options;

    const oriOptions = {
      sourceAddress,
      optimismDecoder,
      logicDecoder,
      treeOptions,
      web3,
      parentORI,
    };

    const fraudster = new OptimisticRollIn(oriInstance, logicInstance, suspect, oriOptions);

    // Build a partial merkle tree (for the call data) from the proof data pulled from this transaction
    const appendProof = { appendElements: toBuffer(callDataArrayHex), compactProof: toBuffer(proofHex) };
    const callDataPartialTree = PartialMerkleTree.fromAppendProof(appendProof, treeOptions);

    fraudster._state = {
      user: suspect,
      callDataTree: callDataPartialTree,
      currentState: toBuffer(newStateHex),
      lastTime: lastTime,
      fraudIndex: callDataPartialTree.elements.length - callDataArrayHex.length + fraudIndex,
    };

    fraudster._frauds = null;

    return fraudster;
  }

  // GETTER: Returns the current state of the account's data
  get currentState() {
    return this._state.currentState;
  }

  // GETTER: Returns the current state of the account's data
  get queuedState() {
    const queueLength = this._queue.newStates.length;
    return queueLength ? this._queue.newStates[queueLength - 1] : this._state.currentState;
  }

  // GETTER: Returns the last optimistic time of the account
  get lastTime() {
    return this._state.lastTime;
  }

  // GETTER: Returns the index of fraud, if it exists
  get fraudIndex() {
    return this._state.fraudIndex;
  }

  // GETTER: Returns the computed account state
  get accountState() {
    return hashPacked([this._state.callDataTree.root, this._state.currentState, to32ByteBuffer(this._state.lastTime)]);
  }

  // GETTER: Returns the number of optimistic transitions of the account
  get transitionCount() {
    // TODO: this only considers on-chain transitions, but not locally queued ones
    return this._state.callDataTree.elements.length;
  }

  // GETTER: Returns if in optimistic state
  get isInOptimisticState() {
    // return !this._state.callDataTree.root.equals(to32ByteBuffer(0)) && this._state.lastTime !== 0;
    return this._state.lastTime !== 0;
  }

  // GETTER: Returns if in optimistic state
  get transitionsQueued() {
    return this._queue.newStates.length;
  }

  // PRIVATE: Updates the state with empty call data tree, computed new state, and 0 last optimistic time
  _updateStatePessimistically(newState) {
    this._state.callDataTree = new MerkleTree([], this._treeOptions);
    this._state.currentState = newState;
    this._state.lastTime = 0;
  }

  // PRIVATE: Updates the state with new call data tree, new state, and last optimistic time
  _updateStateOptimistically(newMerkleTree, newState, lastTime) {
    this._state.callDataTree = newMerkleTree;
    this._state.currentState = newState;
    this._state.lastTime = lastTime;
  }

  // PRIVATE: Creates and stores an ORI instance by cloning current instance, and setting account to fraudulent user's data
  _recordFraud(parameters) {
    const { suspect } = parameters;

    const options = {
      oriInstance: this._oriContractInstance,
      logicInstance: this._logicContractInstance,
      sourceAddress: this._sourceAddress,
      treeOptions: this._treeOptions,
      optimismDecoder: this._optimismDecoder,
      logicDecoder: this._logicDecoder,
      web3: this._web3,
      parentORI: this,
    };

    this._frauds[suspect] = OptimisticRollIn.fraudsterFromProof(parameters, options);
  }

  async _isValidTransition(suspectHex, callDataHex, newStateHex, options = {}) {
    const { pureVerifiers } = options;

    // Decode sighash and use from calldata
    const decodedCallData = this._logicDecoder.decodeFn(callDataHex);
    const { sighash, user } = decodedCallData;

    // If the user extracted from the calldata does not match, its invalid
    if (suspectHex.toLowerCase() !== user.toLowerCase()) return false;

    try {
      // If a pure function was provided to compute this locally, then use it
      if (pureVerifiers?.[sighash]) return toHex(pureVerifiers[sighash](decodedCallData, newStateHex));

      // If not, we ned to verify against with the node, which is slower
      const callObject = { to: this._logicContractInstance.address, data: callDataHex };
      return (await this._web3.eth.call(callObject)) === newStateHex;
    } catch (err) {
      console.log(err);
      console.log(err.message);
    }

    return false;
  }

  // PRIVATE: Verifies an optimistic transition, and creates a fraudster ORI if fraud is found
  async _verifyTransition(suspectHex, decodedOptimismData, lastTime, options) {
    // Decode the optimism input data
    const { call_data: callDataHex, new_state: newStateHex, proof: proofHex } = decodedOptimismData;

    if (await this._isValidTransition(suspectHex, callDataHex, newStateHex, options)) {
      return { valid: true, user: suspectHex };
    }

    this._recordFraud({
      suspect: suspectHex,
      fraudIndex: 0,
      callDataArrayHex: [callDataHex],
      newStateHex,
      proofHex,
      lastTime,
    });

    return { valid: false, user: suspectHex };
  }

  // PRIVATE: Verifies batch optimistic transitions, and creates a fraudster ORI if fraud is found
  async _verifyBatchTransitions(suspectHex, decodedOptimismData, lastTime, options) {
    // Decode the optimism input data
    const { call_data: callDataArrayHex, new_state: newStateHex, proof: proofHex } = decodedOptimismData;

    // Compute what the new states should have been, from the original state
    for (let i = 0; i < callDataArrayHex.length; i++) {
      const intermediateStateHex =
        i === callDataArrayHex.length - 1
          ? newStateHex
          : this._logicDecoder.decodeFn(callDataArrayHex[i + 1]).current_state;

      if (await this._isValidTransition(suspectHex, callDataArrayHex[i], intermediateStateHex, options)) continue;

      this._recordFraud({
        suspect: suspectHex,
        fraudIndex: i,
        callDataArrayHex,
        newStateHex,
        proofHex,
        lastTime,
      });

      return { valid: false, user: suspectHex };
    }

    return { valid: true, user: suspectHex };
  }

  // PRIVATE: Updates internal account given some new optimistic transition
  _updateWithTransition(decodedOptimismData, lastTime) {
    // Decode the optimism input data
    const {
      call_data: callDataHex,
      new_state: newStateHex,
      call_data_root: callDataRootHex,
      last_time: originalLastTimeBN,
    } = decodedOptimismData;

    assert(originalLastTimeBN.toNumber() === this._state.lastTime, 'Last time mismatch.');
    assert(toBuffer(callDataRootHex).equals(this._state.callDataTree.root), 'Root mismatch.');

    // Check that this last transition was valid, by decoding arg from calldata and compute expected new state
    const { current_state: startingStateHex } = this._logicDecoder.decodeFn(callDataHex);
    assert(toBuffer(startingStateHex).equals(this._state.currentState), 'State mismatch.');

    const newMerkleTree = this._state.callDataTree.append(toBuffer(callDataHex));
    this._updateStateOptimistically(newMerkleTree, toBuffer(newStateHex), lastTime);
  }

  // PRIVATE: Updates internal account given some new batch optimistic transitions
  _updateWithBatchTransitions(decodedOptimismData, lastTime) {
    // Decode the optimism input data
    const {
      call_data: callDataArrayHex,
      new_state: newStateHex,
      call_data_root: callDataRootHex,
      last_time: originalLastTimeBN,
    } = decodedOptimismData;

    assert(originalLastTimeBN.toNumber() === this._state.lastTime, 'Last time mismatch.');
    assert(toBuffer(callDataRootHex).equals(this._state.callDataTree.root), 'Root mismatch.');

    // Check that this last transition was valid, by decoding arg from calldata and compute expected new state
    const { current_state: startingStateHex } = this._logicDecoder.decodeFn(callDataArrayHex[0]);
    assert(toBuffer(startingStateHex).equals(this._state.currentState), 'State mismatch.');

    const newMerkleTree = this._state.callDataTree.append(toBuffer(callDataArrayHex));
    this._updateStateOptimistically(newMerkleTree, toBuffer(newStateHex), lastTime);
  }

  // PRIVATE: Non-optimistically perform a transition, and update internal state (only for self)
  async _performPessimistically(functionName, args = [], options = {}) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    const { value = '0' } = options;

    const callDataHex = await this._getCalldata(this._state.user, this._state.currentState, functionName, args);

    const result = await this._oriContractInstance.perform(callDataHex, { from: this._sourceAddress, value });

    const oriLog = result.receipt.logs.find(({ event }) => event === 'ORI_New_State');

    const newState = toBuffer(oriLog.args[1]);

    this._updateStatePessimistically(newState);

    return Object.assign({ newState }, result);
  }

  // PRIVATE: Non-optimistically perform a transition to exit optimistic state, and update internal state (only for self)
  async _performPessimisticallyWhileExitingOptimism(functionName, args = [], options = {}) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    const { value = '0' } = options;

    const callDataHex = await this._getCalldata(this._state.user, this._state.currentState, functionName, args);

    const result = await this._oriContractInstance.perform_and_exit(
      callDataHex,
      toHex(this._state.callDataTree.root),
      this._state.lastTime,
      { from: this._sourceAddress, value }
    );

    const oriLog = result.receipt.logs.find(({ event }) => event === 'ORI_New_State');

    const newState = toBuffer(oriLog.args[1]);

    this._updateStatePessimistically(newState);

    return Object.assign({ newState }, result);
  }

  // PRIVATE: Optimistically perform a transition to enter optimistic state, and update internal state (only for self)
  async _performOptimisticallyWhileEnteringOptimism(functionName, args = [], newState) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    const callDataHex = await this._getCalldata(this._state.user, this._state.currentState, functionName, args);

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendSingle(toBuffer(callDataHex), proofOptions);

    const result = await this._oriContractInstance.perform_optimistically_and_enter(
      callDataHex,
      toHex(newState),
      toHex(proof.compactProof),
      { from: this._sourceAddress }
    );

    const oriLog = result.receipt.logs.find(({ event }) => event === 'ORI_New_Optimistic_State');

    const lastTime = parseInt(oriLog.args[1], 10);

    this._updateStateOptimistically(newMerkleTree, newState, lastTime);

    return Object.assign({ newState }, result);
  }

  // PRIVATE: Optimistically perform a transition while already in optimistic state, and update internal state (only for self)
  async _performOptimistically(functionName, args = [], newState) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    const callDataHex = await this._getCalldata(this._state.user, this._state.currentState, functionName, args);

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendSingle(toBuffer(callDataHex), proofOptions);

    const result = await this._oriContractInstance.perform_optimistically(
      callDataHex,
      toHex(newState),
      toHex(proof.root),
      toHex(proof.compactProof),
      this._state.lastTime,
      { from: this._sourceAddress }
    );

    const oriLog = result.receipt.logs.find(({ event }) => event === 'ORI_New_Optimistic_State');

    const lastTime = parseInt(oriLog.args[1], 10);

    this._updateStateOptimistically(newMerkleTree, newState, lastTime);

    return Object.assign({ newState }, result);
  }

  // PRIVATE: Optimistically perform batch transitions while already in optimistic state, and update internal state (only for self)
  async _performBatchOptimistically(functionNames = [], args = [], newStates = []) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');
    assert(functionNames.length > 0, 'No function calls specified.');
    assert(functionNames.length === args.length, 'Function and args count mismatch.');

    // Compute the new state from the current state, locally
    const callDataArray = [];
    let newState = this._state.currentState;

    for (let i = 0; i < functionNames.length; i++) {
      const callDataHex = await this._getCalldata(this._state.user, newState, functionNames[i], args[i]);
      callDataArray.push(toBuffer(callDataHex));
      newState = newStates[i];
    }

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendMulti(callDataArray, proofOptions);

    const result = await this._oriContractInstance.perform_many_optimistically(
      toHex(callDataArray),
      toHex(newState),
      toHex(proof.root),
      toHex(proof.compactProof),
      this._state.lastTime,
      { from: this._sourceAddress }
    );

    const oriLog = result.receipt.logs.find(({ event }) => event === 'ORI_New_Optimistic_States');

    const lastTime = parseInt(oriLog.args[1], 10);

    this._updateStateOptimistically(newMerkleTree, newState, lastTime);

    return Object.assign({ newState }, result);
  }

  // PRIVATE: Optimistically perform batch transitions to enter optimistic state, and update internal state (only for self)
  async _performBatchOptimisticallyWhileEnteringOptimism(functionNames = [], args = [], newStates = []) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');
    assert(functionNames.length > 0, 'No function calls specified.');
    assert(functionNames.length === args.length, 'Function and args count mismatch.');

    // Compute the new state from the current state, locally
    const callDataArray = [];
    let newState = this._state.currentState;

    for (let i = 0; i < functionNames.length; i++) {
      const callDataHex = await this._getCalldata(this._state.user, newState, functionNames[i], args[i]);
      callDataArray.push(toBuffer(callDataHex));
      newState = newStates[i];
    }

    // Get the expected new call data tree and append proof
    const { proof, newMerkleTree } = this._state.callDataTree.appendMulti(callDataArray, proofOptions);

    const result = await this._oriContractInstance.perform_many_optimistically_and_enter(
      toHex(callDataArray),
      toHex(newState),
      toHex(proof.compactProof),
      { from: this._sourceAddress }
    );

    const oriLog = result.receipt.logs.find(({ event }) => event === 'ORI_New_Optimistic_States');

    const lastTime = parseInt(oriLog.args[1], 10);

    this._updateStateOptimistically(newMerkleTree, newState, lastTime);

    return Object.assign({ newState }, result);
  }

  // PRIVATE: performs a non-optimistic contract call, on-chain
  async _pessimisticCall(functionName, args, options) {
    // if in optimism and can't exit yet, throw
    assert(this.isInOptimisticState || (await this.canExit()), 'In optimistic state and cannot yet exit.');

    // if in optimism and can exit, perform and exit
    if (this.isInOptimisticState) return this._performPessimisticallyWhileExitingOptimism(functionName, args, options);

    // if not in optimism, perform
    return this._performPessimistically(functionName, args, options);
  }

  // PRIVATE: performs an optimistic contract call, on-chain
  _optimisticCall(functionName, args, newState) {
    // if not in optimism, perform and enter
    if (!this.isInOptimisticState)
      return this._performOptimisticallyWhileEnteringOptimism(functionName, args, newState);

    // if in optimism, perform optimistically
    return this._performOptimistically(functionName, args, newState);
  }

  // PRIVATE: queues a transition to be broadcasted in batch later
  _queueCall(functionName, args = [], newState) {
    this._queue.newStates.push(newState);
    this._queue.functionNames.push(functionName);
    this._queue.args.push(args);
  }

  // PRIVATE: Returns call data hex needed to call a function, given the current state and args
  async _getCalldata(user, currentState, functionName, args = []) {
    // Get the call logic contract address and call data from a logic request
    // TODO: this can and should be done locally and synchronously
    const { data: callDataHex } = await this._logicContractInstance[functionName].request(
      toHex(user),
      toHex(currentState),
      ...args,
      { from: this._sourceAddress }
    );

    return callDataHex;
  }

  // PUBLIC: Bonds the user's account, using the source address (which may be the same as the user)
  bond(amount) {
    // TODO: prevent over-bonding unless option to force

    const callOptions = { value: amount, from: this._sourceAddress };
    return this._oriContractInstance.bond(this._state.user, callOptions);
  }

  // PUBLIC: Initialize the on-chain account and the internal state (only for self)
  async initialize(options = {}) {
    assert(this._sourceAddress === this._state.user, 'Can only initialize own account.');

    // TODO: prevent initializing already initialized account

    const { deposit = '0', bond = '0' } = options;
    const value = (BigInt(deposit) + BigInt(bond)).toString();
    const callOptions = { value, from: this._sourceAddress };
    const result = await this._oriContractInstance.initialize(bond, callOptions);

    const oriLog = result.receipt.logs.find(({ event }) => event === 'ORI_New_State');

    this._updateStatePessimistically(toBuffer(oriLog.args[1]));

    return result;
  }

  // PUBLIC: Rolls the entire transition queue into a single transaction and broadcasts (only for self)
  async sendQueue() {
    // if in optimism, perform optimistically, else, perform and enter
    const result = this.isInOptimisticState
      ? await this._performBatchOptimistically(this._queue.functionNames, this._queue.args, this._queue.newStates)
      : await this._performBatchOptimisticallyWhileEnteringOptimism(
          this._queue.functionNames,
          this._queue.args,
          this._queue.newStates
        );

    this.clearQueue();

    return result;
  }

  // PUBLIC: Clear the queued transitions
  clearQueue() {
    this._queue.newStates.length = 0;
    this._queue.functionNames.length = 0;
    this._queue.args.length = 0;
  }

  // TODO: function to build chain of optimistic transition, without submitting
  async placeholder() {}

  // PUBLIC: Returns an ORI instance (if exists) for a fraudulent user's address
  getFraudster(user) {
    return this._frauds[user.toLowerCase()];
  }

  // PUBLIC: Locks user's account, from the source address (which may be the same as the user)
  lock(options = {}) {
    // TODO: check if suspect already locked
    const { bond = '0' } = options;

    return this._oriContractInstance.lock_user(this._state.user, { value: bond, from: this._sourceAddress });
  }

  // PUBLIC: Updates the internal state given an optimistic tx
  async update(txId) {
    // TODO: should not update unless its a fraudster (partial merkle tree)

    // Pull the transaction containing the suspected fraudulent transition
    const tx = await this._web3.eth.getTransaction(txId);
    const decodedOptimismData = this._optimismDecoder.decodeFn(tx.input);
    const { sighash } = decodedOptimismData;

    // Pull the transaction receipt containing the suspected fraudulent transition's logs
    const receipt = await this._web3.eth.getTransactionReceipt(txId);

    const oriLog = receipt.logs.find(({ topics }) =>
      [ORI_New_Optimistic_State, ORI_New_Optimistic_States].includes(topics[0])
    );

    const user = '0x' + oriLog.topics[1].slice(26);

    assert(user === this._state.user, 'User mismatch.');

    const lastTime = parseInt(oriLog.topics[2].slice(2), 16);

    if (sighash === '0x08542bb1' || sighash === '0x6a8dddef') {
      return this._updateWithBatchTransitions(decodedOptimismData, lastTime);
    }

    if (sighash === '0x177f15c5' || sighash === '0x1646d051') {
      return this._updateWithTransition(decodedOptimismData, lastTime);
    }

    return;
  }

  // PUBLIC: Verifies the transitions(s) of an optimistic tx, and creates a fraudster ORI if fraud is found
  async verifyTransaction(txId, options) {
    // Pull the transaction containing the suspected fraudulent transition
    const tx = await this._web3.eth.getTransaction(txId);
    const decodedOptimismData = this._optimismDecoder.decodeFn(tx.input);
    const { sighash } = decodedOptimismData;

    // Pull the transaction receipt containing the suspected fraudulent transition's logs
    const receipt = await this._web3.eth.getTransactionReceipt(txId);

    const oriLog = receipt.logs.find(({ topics }) =>
      [ORI_New_Optimistic_State, ORI_New_Optimistic_States].includes(topics[0])
    );

    const suspectHex = '0x' + oriLog.topics[1].slice(26);
    const lastTime = parseInt(oriLog.topics[2].slice(2), 16);

    return sighash === '0x08542bb1' || sighash === '0x6a8dddef'
      ? await this._verifyBatchTransitions(suspectHex, decodedOptimismData, lastTime, options)
      : sighash === '0x177f15c5' || sighash === '0x1646d051'
      ? await this._verifyTransition(suspectHex, decodedOptimismData, lastTime, options)
      : { valid: true };
  }

  // PUBLIC: Submit proof to ORI contract that account user committed fraud
  async proveFraud() {
    // Build a Multi Proof for the call data of the fraudulent transition
    const indices = [this._state.fraudIndex, this._state.fraudIndex + 1];
    const { root, elements, compactProof } = this._state.callDataTree.generateMultiProof(indices, proofOptions);

    // Prove the fraud
    const result = await this._oriContractInstance.prove_fraud(
      this._state.user,
      toHex(elements),
      toHex(this._state.currentState),
      toHex(root),
      toHex(compactProof),
      this._state.lastTime,
      { from: this._sourceAddress }
    );

    // TODO: This is just a hack to prevent re-proving fraud after the first success
    this._state.fraudIndex = null;

    if (this._parentORI) {
      this._parentORI.deleteFraudster(this._state.user);
    }

    return result;
  }

  // PUBLIC: Delete internal fraudster object
  deleteFraudster(user) {
    this._frauds[user] = null;
  }

  // PUBLIC: Unbonds the user's account to some destination
  unbond(destination) {
    return this._oriContractInstance.unbond(destination, { from: this._sourceAddress });
  }

  // PUBLIC: Rollback optimistic state (and thus calldata tree) to right before the fraud index
  async rollback(options = {}) {
    const { index = await this.getRollbackSize(), bondAmount = '0' } = options;

    // TODO: check if bond amount is sufficient
    // TODO: detect index from chain

    // Need to create a call data Merkle Tree of all pre-invalid-transition call data
    // Note: rollbackSize is a bad name. Its really the expected size of the tree after the rollback is performed
    const oldCallData = this._state.callDataTree.elements.slice(0, index);
    const oldCallDataTree = new MerkleTree(oldCallData, this._treeOptions);
    const rolledBackCallDataArray = this._state.callDataTree.elements.slice(index);

    // Need to build an Append Proof to prove that the old call data root, when appended with the rolled back call data,
    // has the root that equals the root of current on-chain call data tree
    const { proof } = oldCallDataTree.appendMulti(rolledBackCallDataArray, proofOptions);
    const { root: oldRoot, compactProof: appendProof } = proof;

    // Suspect needs to prove to the current size of the on-chain call data tree
    const { root, elementCount, elementRoot: sizeProof } = this._state.callDataTree.generateSizeProof(proofOptions);

    // Suspect performs the rollback while bonding new coin at the same time
    const result = await this._oriContractInstance.rollback(
      toHex(oldRoot),
      toHex(rolledBackCallDataArray),
      toHex(appendProof),
      elementCount,
      toHex(sizeProof),
      toHex(root),
      toHex(this._state.currentState),
      this._state.lastTime,
      { value: bondAmount, from: this._sourceAddress }
    );

    const oriLog = result.receipt.logs.find(({ event }) => event === 'ORI_Rolled_Back');

    const lastTime = parseInt(oriLog.args[2], 10);

    const currentState = rolledBackCallDataArray[0].slice(36, 68);
    this._updateStateOptimistically(oldCallDataTree, currentState, lastTime);

    // TODO: this is weird, because this isn't here for the suspect's own ori instance
    this._state.fraudIndex = null;

    return result;
  }

  // PUBLIC: Returns the account user's balance (on chain)
  getBalance() {
    return this._oriContractInstance.balances(this._state.user);
  }

  // PUBLIC: Returns the account user's balance (on chain)
  getAccountState() {
    return this._oriContractInstance.account_states(this._state.user);
  }

  // PUBLIC: Returns the rollback size that the account needs to be rolled back to (on chain)
  getRollbackSize() {
    return this._oriContractInstance.rollback_sizes(this._state.user);
  }

  // PUBLIC: Returns whether the account is in an optimistic state (on chain)
  async getIsInOptimisticState() {
    const accountState = await getAccountState();

    return hashPacked([to32ByteBuffer(0), this._state.currentState, to32ByteBuffer(0)]).equals(accountState);
  }

  // PUBLIC: Returns lock time for the account (on chain)
  getLockTime() {
    return this._oriContractInstance.locked_times(this._state.user);
  }

  // PUBLIC: Returns approximate time remaining until account can exit optimism (on chain)
  async getTimeLeftToPessimism() {
    const currentBlockNumber = await this._web3.eth.getBlockNumber();
    const { timestamp } = await this._web3.eth.getBlock(currentBlockNumber);
    const lockTime = await this.getLockTime();

    // TODO: make threshold an ORI option
    return timestamp - (lockTime.toNumber() + 600);
  }

  // PUBLIC: Returns if can exit optimism (on chain)
  async canExit() {
    return (await this.getTimeLeftToPessimism()) > 0;
  }

  // PUBLIC: Returns the locked of this account, if any (on chain)
  async getLocker() {
    const locker = await this._oriContractInstance.lockers(this._state.user);

    return locker === ZERO_ADDRESS ? null : locker;
  }
}

module.exports = OptimisticRollIn;
