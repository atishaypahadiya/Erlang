// Exit 70 (EX_SOFTWARE) on an internal failure: a crash, not a refusal (2)
// and not bad usage (64). Shared with ITTEN and KERCKHOFFS (the owner, 20
// November 2026). Without this, Node exits 1 on an uncaught error, which
// reads as "failing findings". An error inside one check is not a crash: it
// stops that check and the report is partial (exit 3).
export const EXIT_INTERNAL = 70;

export function exitOnCrash(label) {
  const die = (e) => {
    try { process.stderr.write(`${label}: internal failure (exit ${EXIT_INTERNAL}): ${e?.stack ?? e}\n`); } finally { process.exit(EXIT_INTERNAL); }
  };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
}
