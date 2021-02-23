package main

import (
	"context"
	"crypto/ecdsa"
	"log"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/rogercoll/oprollups"
)

func main() {
	client, err := ethclient.Dial("http://127.0.0.1:8545")
	if err != nil {
		log.Fatal(err)
	}

	address := common.HexToAddress("0x8B503cA1beF55A904276138f2EA60906d2c58781")
	opr, err := oprollups.New(address, client)
	if err != nil {
		log.Fatal(err)
	}
	err = opr.LockTime()
	if err != nil {
		log.Fatal(err)
	}

	privateKey, err := crypto.HexToECDSA("cd40c0e859b7f6ebf942ee4b2f923acbe54546e9339a025de4b173f442187828")
	if err != nil {
		log.Fatal(err)
	}

	publicKey := privateKey.Public()
	publicKeyECDSA, ok := publicKey.(*ecdsa.PublicKey)
	if !ok {
		log.Fatal("error casting public key to ECDSA")
	}

	fromAddress := crypto.PubkeyToAddress(*publicKeyECDSA)

	nonce, err := client.PendingNonceAt(context.Background(), fromAddress)
	if err != nil {
		log.Fatal(err)
	}

	gasPrice, err := client.SuggestGasPrice(context.Background())
	if err != nil {
		log.Fatal(err)
	}

	auth := bind.NewKeyedTransactor(privateKey)
	auth.Nonce = big.NewInt(int64(nonce))
	auth.Value = big.NewInt(100)   // in wei
	auth.GasLimit = uint64(300000) // in units
	auth.GasPrice = gasPrice

	err = opr.Bond(auth, fromAddress)
	if err != nil {
		log.Fatal(err)
	}
}
