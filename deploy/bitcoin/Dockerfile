# The release archive must be verified against signed SHA256SUMS before building.
FROM debian:bookworm-slim
COPY install/bitcoin-32.1/bin/bitcoind /usr/local/bin/bitcoind
COPY install/bitcoin-32.1/bin/bitcoin-cli /usr/local/bin/bitcoin-cli
USER 1000:1000
ENTRYPOINT ["bitcoind"]
CMD ["-datadir=/data", "-conf=/data/bitcoin.conf"]
