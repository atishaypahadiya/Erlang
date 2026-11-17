// Seeds the local database before a run. Not part of the service, so the
// fixture's erlang.config.json excludes scripts/: this call is never reported.
const res = await fetch(`${process.env.SEED_URL}/fixtures`);
console.log(await res.json());
