package oprollups

import (
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	store "github.com/rogercoll/oprollups/contracts"
)

type Oprollups struct {
	ori_addr      common.Address
	ori_contract  *store.Contracts
	required_bond *big.Int
}

func New(_ori_addr common.Address, ethClient *ethclient.Client) (*Oprollups, error) {
	instance, err := store.NewContracts(_ori_addr, ethClient)
	if err != nil {
		return nil, err
	}
	requiredBond, err := instance.RequiredBond(nil)
	if err != nil {
		return nil, err
	}
	return &Oprollups{ori_addr: _ori_addr, ori_contract: instance, required_bond: requiredBond}, nil
}

func (ori *Oprollups) Version() string {
	return "hello"
}

func (ori *Oprollups) Balance(user common.Address) {

}

func (ori *Oprollups) Bond(opts *bind.TransactOpts, user common.Address) error {
	acutalBalance, err := ori.ori_contract.Balances(nil, user)
	if err != nil {
		return err
	}
	fmt.Printf("Actual account balance: %v\n", acutalBalance)
	fmt.Printf("Actual required bond: %v\n", ori.required_bond)
	if acutalBalance.Cmp(ori.required_bond) >= 0 {
		return errors.New("Bond not required")
	}
	reminder, err := ori.ori_contract.Bond(opts, user)
	if err != nil {
		return err
	}
	fmt.Printf("Reminder weis: %v\n", reminder)
	return nil
}

func (ori *Oprollups) LockTime() error {
	lockTime, err := ori.ori_contract.LockTime(nil)
	if err != nil {
		return err
	}
	fmt.Printf("Total lock time: %v\n", lockTime)
	return nil
}

func Hello() {
	fmt.Println("Hello")
}
