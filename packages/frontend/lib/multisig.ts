import { ethers } from "ethers";
import { getSafeAddress, getModuleAddress } from "./safe";
import { waitForMirrorNode, type RebalanceStatus } from "./txStatus";

/**
 * Owner management and quorum-gated rebalance proposals. `RebalanceModule.rebalance()` requires
 * msg.sender == the Safe itself (see AGENTS.md) — there is no other way to call it. So every
 * rebalance, even under a 1-of-N Safe, goes through the same Safe-transaction machinery here:
 * build the exact (to, data, nonce) tuple, get owners to approve its hash on-chain via
 * `approveHash()`, then submit `execTransaction()` once enough approvals exist. At threshold 1
 * this collapses to a single click (the proposer's own approval already meets quorum); at a
 * higher threshold it's a real multi-owner flow, since `approveHash()` is what lets an owner
 * commit their approval from their own wallet/session without a backend to relay signatures.
 */

const SAFE_TX_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function approvedHashes(address owner, bytes32 hash) view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes memory signatures) payable returns (bool)"
];

const OWNER_MGMT_ABI = ["function addOwnerWithThreshold(address owner, uint256 _threshold)"];

const MODULE_ABI = [
  "function rebalance(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline) returns (uint256)"
];

const moduleIface = new ethers.Interface(MODULE_ABI);
const ownerMgmtIface = new ethers.Interface(OWNER_MGMT_ABI);

function safeContract(runner: ethers.Provider | ethers.Signer): ethers.Contract {
  return new ethers.Contract(getSafeAddress(), SAFE_TX_ABI, runner);
}

/** The `v=1, r=owner, s=0` "approved hash" scheme: valid when either `msg.sender == owner`
 * (submitting your own transaction) or `owner` has already called `approveHash()` on-chain for
 * this exact hash. Every signature in a multi-owner `execTransaction` call uses this form — no
 * real ECDSA signing needed, since on-chain approval already proves the owner's intent. */
function approvedHashSignature(owner: string): string {
  return ethers.concat([ethers.zeroPadValue(owner, 32), ethers.ZeroHash, "0x01"]);
}

function buildApprovedHashSignatures(approvedOwners: string[]): string {
  // Safe requires signatures sorted by signer address, ascending.
  const sorted = [...approvedOwners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return ethers.concat(sorted.map(approvedHashSignature));
}

/** Runs a Safe-contract-sending call through the same submit/pending/mirror-node status flow
 * every trigger in this app uses, so the UI's step tracker works identically here too. */
async function runSafeTx(
  send: () => Promise<ethers.ContractTransactionResponse>,
  onStatus: (status: RebalanceStatus) => void
): Promise<boolean> {
  onStatus({ stage: "submitting" });
  let tx: ethers.ContractTransactionResponse;
  try {
    tx = await send();
  } catch (error) {
    onStatus({ stage: "failed", error: (error as Error).message });
    return false;
  }

  onStatus({ stage: "pending", txHash: tx.hash });
  try {
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      onStatus({ stage: "failed", txHash: tx.hash, error: "Transaction reverted" });
      return false;
    }
  } catch (error) {
    onStatus({ stage: "failed", txHash: tx.hash, error: (error as Error).message });
    return false;
  }

  onStatus({ stage: "confirming", txHash: tx.hash });
  await waitForMirrorNode(tx.hash, onStatus);
  return true;
}

/**
 * Adds an owner while the Safe is still 1-of-N — only works when `signer` is an existing owner
 * and the current threshold lets a single owner act alone (the `msg.sender == owner` shortcut in
 * the approved-hash scheme). Going from 1 owner to 3 is two calls: the first keeps the threshold
 * unchanged, the second raises it to the target in the same call that adds the third owner — both
 * still doable solo, since the threshold only takes effect *after* that call executes.
 */
export async function addOwner(
  signer: ethers.Signer,
  newOwner: string,
  newThreshold: number,
  onStatus: (status: RebalanceStatus) => void
): Promise<void> {
  const safeAddress = getSafeAddress();
  const signerAddress = await signer.getAddress();
  const safe = safeContract(signer);
  const data = ownerMgmtIface.encodeFunctionData("addOwnerWithThreshold", [newOwner, newThreshold]);

  await runSafeTx(
    () =>
      safe.execTransaction(
        safeAddress,
        0,
        data,
        0,
        0,
        0,
        0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        approvedHashSignature(signerAddress)
      ),
    onStatus
  );
}

export interface RebalanceProposal {
  to: string;
  data: string;
  nonce: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOutMin: string;
  deadline: number;
}

/** The exact Safe transaction a rebalance becomes — every approving owner is agreeing to this
 * bit-for-bit, since the Safe transaction hash covers all of it (including the Safe's current
 * nonce, so a stale proposal can't be replayed after another transaction has gone through). */
export async function buildRebalanceProposal(
  provider: ethers.Provider,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOutMin: bigint,
  deadline: number
): Promise<RebalanceProposal> {
  const data = moduleIface.encodeFunctionData("rebalance", [
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMin,
    deadline
  ]);
  const nonce: bigint = await safeContract(provider).nonce();
  return {
    to: getModuleAddress(),
    data,
    nonce: nonce.toString(),
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOutMin: amountOutMin.toString(),
    deadline
  };
}

/** Proposals are shared between owners by copy/paste (no backend to relay them) — a compact
 * blob of exactly the fields that determine the Safe transaction hash, nothing recomputed from
 * a live quote, so every owner is reviewing and approving the identical transaction. */
export function encodeProposal(proposal: RebalanceProposal): string {
  return btoa(JSON.stringify(proposal));
}

export function decodeProposal(blob: string): RebalanceProposal {
  let parsed: Partial<RebalanceProposal>;
  try {
    parsed = JSON.parse(atob(blob.trim()));
  } catch {
    throw new Error("That doesn't look like a valid proposal — check it was copied in full.");
  }
  if (!parsed.to || !parsed.data || parsed.nonce === undefined) {
    throw new Error("That doesn't look like a valid proposal — missing required fields.");
  }
  return parsed as RebalanceProposal;
}

export async function getProposalHash(provider: ethers.Provider, proposal: RebalanceProposal): Promise<string> {
  return safeContract(provider).getTransactionHash(
    proposal.to,
    0,
    proposal.data,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    proposal.nonce
  );
}

/** Which of the Safe's current owners have already approved this exact hash on-chain. */
export async function getApprovals(
  provider: ethers.Provider,
  owners: string[],
  hash: string
): Promise<string[]> {
  const safe = safeContract(provider);
  const flags = await Promise.all(owners.map((owner) => safe.approvedHashes(owner, hash)));
  return owners.filter((_, i) => (flags[i] as bigint) !== 0n);
}

export async function approveProposal(
  signer: ethers.Signer,
  hash: string,
  onStatus: (status: RebalanceStatus) => void
): Promise<void> {
  const safe = safeContract(signer);
  await runSafeTx(() => safe.approveHash(hash), onStatus);
}

/** Submits the actual rebalance once enough owners have approved — anyone can call this (it
 * doesn't need to be an owner), since the signatures already carry every approving owner's
 * on-chain-recorded consent. */
export async function executeProposal(
  signer: ethers.Signer,
  proposal: RebalanceProposal,
  approvedOwners: string[],
  onStatus: (status: RebalanceStatus) => void
): Promise<void> {
  const safe = safeContract(signer);
  const signatures = buildApprovedHashSignatures(approvedOwners);

  await runSafeTx(
    () =>
      safe.execTransaction(
        proposal.to,
        0,
        proposal.data,
        0,
        0,
        0,
        0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        signatures
      ),
    onStatus
  );
}

export interface DecodedRebalance {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOutMin: bigint;
  deadline: number;
}

/** Decodes a proposal's raw calldata back into readable fields — what an approving owner should
 * actually inspect before approving, since the blob itself could have come from anyone. */
export function decodeRebalanceCalldata(data: string): DecodedRebalance {
  const [tokenIn, tokenOut, amountIn, amountOutMin, deadline] = moduleIface.decodeFunctionData(
    "rebalance",
    data
  );
  return {
    tokenIn: tokenIn as string,
    tokenOut: tokenOut as string,
    amountIn: amountIn as bigint,
    amountOutMin: amountOutMin as bigint,
    deadline: Number(deadline)
  };
}
