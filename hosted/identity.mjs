import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

export function createIdentityVerifier(env, resolveJwks = createRemoteJWKSet) {
  const { ATMOS_OIDC_ISSUER, ATMOS_OIDC_AUDIENCE, ATMOS_OIDC_JWKS_URL } = env;
  if (![ATMOS_OIDC_ISSUER, ATMOS_OIDC_AUDIENCE, ATMOS_OIDC_JWKS_URL].some(Boolean)) return null;
  if (![ATMOS_OIDC_ISSUER, ATMOS_OIDC_AUDIENCE, ATMOS_OIDC_JWKS_URL].every(Boolean)) {
    throw new Error('Set issuer, audience and JWKS URL together.');
  }
  const issuer = new URL(ATMOS_OIDC_ISSUER);
  const jwksUrl = new URL(ATMOS_OIDC_JWKS_URL);
  if (issuer.protocol !== 'https:' || jwksUrl.protocol !== 'https:') {
    throw new Error('Atmos OIDC issuer and JWKS URLs must use HTTPS.');
  }
  const jwks = resolveJwks(jwksUrl);
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: ATMOS_OIDC_ISSUER,
        audience: ATMOS_OIDC_AUDIENCE,
        requiredClaims: ['sub', 'iss', 'aud', 'exp'],
        algorithms: ['RS256', 'ES256', 'EdDSA'],
      });
      return payload.sub ? { issuer: payload.iss, subject: payload.sub } : null;
    } catch (error) {
      if (error instanceof errors.JWKSInvalid || error instanceof errors.JWKSTimeout
        || !(error instanceof errors.JOSEError)) throw error;
      return null;
    }
  };
}
