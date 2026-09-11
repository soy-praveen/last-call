// Deploy LastCall to Somnia Shannon. Usage: node contracts/deploy.mjs
import { createPublicClient, createWalletClient, http, formatEther, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaTestnet } from "viem/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { readFileSync, writeFileSync } from "fs";
import { config } from "dotenv";
config();

const { abi, bytecode } = JSON.parse(readFileSync(new URL("./out/LastCall.json", import.meta.url), "utf8"));
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const transport = http(process.env.RPC_URL || "https://dream-rpc.somnia.network");
const pub = createPublicClient({ chain: somniaTestnet, transport });
const wallet = createWalletClient({ chain: somniaTestnet, transport, account });

const collateral = SOMNIA_TESTNET_ADDRESSES.testUsdc;
const module = SOMNIA_TESTNET_ADDRESSES.binaryModule;
console.log("deployer", account.address, "balance", formatEther(await pub.getBalance({ address: account.address })), "STT");

const gas = await pub.estimateGas({ account, data: encodeDeployData({ abi, bytecode, args: [collateral, module] }) });
const fees = await pub.estimateFeesPerGas();
const hash = await wallet.deployContract({
  abi,
  bytecode,
  args: [collateral, module],
  gas: (gas * 13n) / 10n,
  maxFeePerGas: fees.maxFeePerGas * 2n,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
});
console.log("deploy tx", hash);
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== "success") throw new Error("deploy reverted");
console.log("LastCall deployed at", rcpt.contractAddress, "block", rcpt.blockNumber);
const dep = { address: rcpt.contractAddress, collateral, module, chainId: somniaTestnet.id, tx: hash, block: Number(rcpt.blockNumber), deployer: account.address };
writeFileSync(new URL("./out/deployment.json", import.meta.url), JSON.stringify(dep, null, 2));
writeFileSync(new URL("../web/src/deployment.json", import.meta.url), JSON.stringify({ ...dep, abi }, null, 2));
