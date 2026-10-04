import { createProposalsTopic } from "./lib/proposalsTopic";

/**
 * Creates a standalone HCS topic for Safe proposals. `deploy.ts` already creates one per Safe and
 * writes it into .env — use this only to replace a Safe's topic or to create one for a Safe
 * deployed some other way. See README's "Proposal relay via HCS" section.
 *
 * Requires HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY from .env.
 */
async function main() {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  if (!operatorId || !operatorKey) {
    throw new Error("Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in .env");
  }

  console.log("Creating HCS topic for Safe proposals...");
  const topicId = await createProposalsTopic(operatorId, operatorKey, "hedera-safe-swap: Safe proposal relay");
  console.log(`Topic created: https://hashscan.io/testnet/topic/${topicId}`);
  console.log("\nCopy this into .env:");
  console.log(`NEXT_PUBLIC_PROPOSALS_TOPIC_ID=${topicId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
