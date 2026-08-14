const jsonSegment = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const fixture = (family, value) => Object.freeze({ family, value });

export const SYNTHETIC_PROVIDER_FIXTURES = Object.freeze([
  fixture('npm', `npm_${'A'.repeat(36)}`),
  fixture('gitlab_classic', `glpat-${'A'.repeat(20)}`),
  fixture('gitlab_routable', `glpat-${'A'.repeat(27)}.${'a'.repeat(9)}`),
  fixture('google_api_key', `AIza${'A'.repeat(35)}`),
  fixture('stripe_secret_test', `sk_test_${'A'.repeat(24)}`),
  fixture('stripe_secret_live', `sk_live_${'A'.repeat(24)}`),
  fixture('stripe_restricted_test', `rk_test_${'A'.repeat(24)}`),
  fixture('stripe_restricted_live', `rk_live_${'A'.repeat(24)}`),
  fixture('hugging_face', `hf_${'A'.repeat(34)}`),
]);

export const SYNTHETIC_RAW_JWT = [
  jsonSegment({ alg: 'HS256' }),
  jsonSegment({}),
  Buffer.alloc(16, 0x5a).toString('base64url'),
].join('.');

export const SYNTHETIC_SENSITIVE_FIXTURES = Object.freeze([
  ...SYNTHETIC_PROVIDER_FIXTURES,
  fixture('raw_jwt', SYNTHETIC_RAW_JWT),
]);

export const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
