// The process's retry budget: a token bucket every retry draws on. A retry
// spends a token; a request that succeeds first time earns a tenth of one.
let tokens = 10;

export const budget = {
  spend() {
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  },
  earn() {
    tokens = Math.min(10, tokens + 0.1);
  },
};
