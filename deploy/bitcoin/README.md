# Bitcoin receiving node

Deploy separately under /opt/sats4tokens-bitcoin. Verify the official Linux
archive against signed SHA256SUMS before building the image. The server runs a
pruned mainnet node with 1 GiB memory and half a CPU limit. Initial synchronization
still downloads and verifies the historical chain. Pruning targets block storage,
so leave additional room for chainstate, wallet files and growth.

The compose network publishes no ports. Administrative bitcoin-cli calls run
inside the container using the local RPC cookie. Before enabling checkout,
create a blank descriptor wallet with private keys disabled and import the
owner's external receiving descriptor. The owner retains signing keys and backup.

Import only a checksummed mainnet wpkh ranged public descriptor. Validate
getdescriptorinfo.hasprivatekeys=false, isrange=true, and issolvable=true.
Use the actual wallet birth time; timestamp=now is appropriate only for a newly
created unused wallet. The owner should reserve this account for shop receipts
and verify a derived address against their signing wallet before launch.
Watch-only descriptor wallets need their range extended before exhaustion.

Enable the gateway with a separate random RPC password and salted rpcauth.
Restrict its RPC user to getnewaddress, listreceivedbyaddress, gettransaction, getblockchaininfo and getwalletinfo,
for readiness checks. Attach the gateway to this private network
when deploying. Never publish the RPC port or place credentials in the repository.

Before launch, verify main chain, initialblockdownload=false, near-current tip,
wallet loaded and rescans complete. Back up the public wallet database, address
allocation state and order ledger. The owner's signing wallet backup is separate.
