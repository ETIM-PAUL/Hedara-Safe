Standfirst
The Scaffold-HBAR Template Bounty opens for registration on Monday September 14th. Build a production-quality template for a real Hedera use case. If it clears the eligibility gate it goes into the Hedera docs with your authorship credited, one command away from every developer starting on Hedera. Five prizes of $2,000 come from a $10,000 pool.

This post is the full brief: what to build, what gets scored, and how the two weeks run.

Register for the template bounty

What you are building
One public repository. A working scaffold-hbar template for a real Hedera use case, structured so that any developer can run one command and have it running locally:

npm create scaffold-hbar@latest --template your-org/your-repo
scaffold-hbar ships with eight built-in templates today. This bounty adds community-authored external templates alongside them. External templates run from any public GitHub repo, so there is no pull request into scaffold-hbar to get merged and nothing to wait on.

What the repository needs:

A monorepo layout with separate packages/ for contracts and frontend
A template.json manifest declaring capabilities and defaults. Optional in the docs, required here
A README.md covering setup, and an AGENTS.md covering AI-assisted use
At least one Hedera service genuinely in play: HTS, HCS, HSS, or a Solidity contract on Hedera
One verifiable testnet transaction, evidenced by a mirror node or Hashscan link
The stack is Next.js with Hardhat or Foundry, npm or Yarn workspaces, on Node 20.18.3 or later.

On-chain validation needs a funded testnet account. Grab testnet HBAR from the Hedera Portal faucet before you start.

Which integrations count
Ecosystem integration carries 35 points, the largest single block in the rubric, so it is worth being clear about what that means.

An integration scores well when it is load-bearing: the template does something a developer could not easily build alone, and removing the integration would break the point of the template. An SDK imported and called once to tick a box scores low, as does a self-contained app with no ecosystem surface.

Examples ecosystem integrations:

DEXes, including SaucerSwap, Lambdaplex and SilkSuite
Oracles, including Chainlink, Supra and Pyth
Bridges, including Axelar, LayerZero and CCIP
Lending protocols and decentralised storage
Some ecosystem protocols have thin or no Hedera testnet deployments. Where testnet is unavailable, a read-only integration or a forked-mainnet integration is acceptable, so a missing testnet deployment is not a reason to abandon a good idea.

Why build one
Your template becomes the default starting point for a use case, reachable by one command from any terminal.

Templates that clear the eligibility gate are listed in the Hedera docs with your authorship credited, and that listing does not depend on winning a prize.

Documentation placement is permanent, so the template keeps sending developers, and traffic, back to your work long after the bounty closes.

Five prizes of $2,000 are available from a $10,000 pool for the highest-scoring submissions.

CTA: Register for the template bounty [registration landing page, URL TBC]

How it works
Register. Tell the Hedera DevRel team who you are. Takes two minutes.
Join the AMA. Walkthrough of the gate requirements, the rubric, Hedera Harness, and what a strong integration looks like, plus live questions.
Build during the two-week window. From September 21st to October 4th. Push to a public repo under an MIT licence.
Submit before October 4th closes. Repo link, a Hashscan or mirror node link proving a testnet transaction, the dev-ex survey, and your harness spec and validators if you used the harness.
Expanded authoring docs, an illustrative integrations list, and a self-check script for the eligibility gate all go live in the week before the build window opens.

Key dates
Milestone	Date
Registration	Monday September 14th
Building and submissions open	Monday September 21st
AMA and office hours	Tuesday September 29th, 10:00 AM ET
Submissions close	Sunday 4th October, 11:59 PM ET
Judging	Monday October 5th to Friday October 16th
Winners announced	Monday October 19th
The eligibility gate
Judging runs in two stages. Stage one is a mechanical pass or fail, and every item is required. Nothing reaches the panel until it passes, so run the self-check script before submitting.

Scaffolds cleanly via npm create scaffold-hbar@latest --template owner/repo
template.json manifest present and valid
README.md and AGENTS.md present
Install, lint and build pass clean from a fresh scaffold
App boots and core routes return OK
At least one Hedera service in play, with a verifiable testnet transaction and a mirror node or Hashscan link supplied
No committed secrets and no committed .env
MIT licence, original work
Harness spec and validators submitted, if the harness was used
Every template that clears this gate is listed in the docs with credited authorship, whether or not it places.

How templates are scored
Templates that clear the gate are scored out of 100 by the Hedera DevRel panel.

Criterion	Points	What scores well
Ecosystem integration and value	35	The integration is load-bearing. The template is only possible because of it, and a developer gains a capability they could not easily build alone.
Docs quality	30	A developer unfamiliar with the repo goes from scaffold to running app to understanding the pattern without help. Clear setup, prerequisites, env vars, architecture, and an AGENTS.md.
Code quality	20	Idiomatic, readable, sensibly structured monorepo. Meaningful tests. Errors handled. No dead code or AI slop.
Hedera service depth	15	Non-trivial use of native Hedera services. Multiple services composed, or one used with real depth, beats a single token transfer.
Build it fast with Hedera Harness
Hedera Harness gives an AI coding agent the context it needs to write working Hedera code: the service APIs, the patterns, and tiered validation. It is strongly recommended for this bounty and it is not required. Templates built without it are judged on exactly the same rubric.

If you use it, submit your harness spec and validators alongside the repo.

Link: github.com/hedera-dev/hedera-harness

Prizes and recognition
$10,000 in total, split as five equal prizes of $2,000, all decided by the panel on the rubric above.

Prizes go only to submissions that clear the eligibility gate. If three templates pass, three prizes are paid and the rest of the pool stays unallocated.

Every template that passes the gate is added to the external templates docs listing with credited authorship, independent of prizes. Winners additionally get a showcase and blog feature.

Questions
Who can enter?

Anyone. No gating, no application review. Existing Hedera experience helps, and the kickoff AMA covers what you need to know if this is your first Hedera build.

Can teams enter?

Yes. Register as a team and give the team size. A prize is a single $2,000 award per winning submission.

How many templates can one person submit?

Each submission is judged on its own. Focus usually scores better than volume, given how much weight the rubric puts on docs quality.

What counts as ecosystem integration?

DEXes, oracles, bridges, lending and storage protocols live in the Hedera ecosystem. The list on this page is illustrative, not a checklist. What matters is that the integration is load-bearing rather than decorative.

What if the protocol I want to integrate has no Hedera testnet deployment?

A read-only integration or a forked-mainnet integration is acceptable. Document the approach in your README.

Do I have to use Hedera Harness?

No. Templates built without it score on the same rubric. If you do use it, submit your harness spec and validators with the repo.

Does the use case have to be original?

The code has to be original work under an MIT licence. The use case does not have to be unheard of. A well-built template for a common pattern is more useful to developers than a novel one nobody needs.

What happens to the template after the bounty?

It stays yours. The docs listing points at your repository, credited to you, and you continue to maintain it.