// Compile contracts/LastCall.sol with solc-js. Writes ABI + bytecode to contracts/out/.
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const src = readFileSync(new URL("./LastCall.sol", import.meta.url), "utf8");
const input = {
  language: "Solidity",
  sources: { "LastCall.sol": { content: src } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
const c = out.contracts["LastCall.sol"].LastCall;
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL("./out/LastCall.json", import.meta.url), JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));
console.log(`compiled LastCall: ${c.evm.deployedBytecode.object.length / 2} bytes deployed`);
