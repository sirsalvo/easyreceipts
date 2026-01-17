// Auth utilities for AWS Cognito token management
import { DEFAULT_CONFIG } from './config';

const TOKEN_KEY = 'spendify_id_token';
const ACCESS_TOKEN_KEY = 'spendify_access_token';
const PKCE_VERIFIER_KEY = 'spendify_pkce_verifier';
const OAUTH_FLOW_KEY = 'spendify_oauth_flow';
const OAUTH_STATE_KEY = 'spendify_oauth_state';
const DEV_MODE_KEY = 'spendify_dev_mode';

export type OAuthFlow = 'implicit' | 'authorization_code' | 'authorization_code_no_pkce';

export interface AuthSession {
  idToken: string;
  accessToken?: string;
  expiresAt?: number;
}

export interface DiagnosticsResult {
  domainValid: boolean;
  domainError?: string;
  normalizedDomain?: string;
  openidConfig?: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
  };
  openidError?: string;
  authorizeUrl?: string;
}

// Dev Mode functions - bypass auth during development
export const setDevMode = (enabled: boolean): void => {
  localStorage.setItem(DEV_MODE_KEY, enabled ? 'true' : 'false');
};

export const isDevMode = (): boolean => {
  return localStorage.getItem(DEV_MODE_KEY) === 'true';
};

export const saveAuthSession = (session: AuthSession): void => {
  localStorage.setItem(TOKEN_KEY, session.idToken);
  if (session.accessToken) {
    localStorage.setItem(ACCESS_TOKEN_KEY, session.accessToken);
  }
};

export const getAuthToken = (): string | null => {
  if (isDevMode()) {
    return 'dev-mode-token';
  }
  return localStorage.getItem(TOKEN_KEY);
};

export const getAccessToken = (): string | null => {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
};

export const clearAuthSession = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(PKCE_VERIFIER_KEY);
  localStorage.removeItem(OAUTH_STATE_KEY);
};

export const isAuthenticated = (): boolean => {
  if (isDevMode()) {
    return true;
  }
  return !!getAuthToken();
};

// Parse tokens from Cognito Hosted UI redirect hash (Implicit flow)
export const parseAuthCallback = (): AuthSession | null => {
  const hash = window.location.hash;
  
  if (!hash) return null;

  const params = new URLSearchParams(hash.substring(1));
  const idToken = params.get('id_token');
  const accessToken = params.get('access_token');

  if (idToken) {
    return {
      idToken,
      accessToken: accessToken || undefined,
    };
  }

  return null;
};

// Normalize and validate Cognito domain
export const normalizeCognitoDomain = (domain: string): { normalized: string; error?: string } => {
  let cleaned = domain.trim();
  
  // Remove trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');
  
  // Check for paths that shouldn't be there
  const pathPatterns = ['/login', '/oauth2', '/logout', '/signup'];
  for (const pattern of pathPatterns) {
    if (cleaned.includes(pattern)) {
      return { 
        normalized: cleaned, 
        error: `Remove "${pattern}" from the domain. Enter only the base domain.` 
      };
    }
  }
  
  // Auto-prepend https if missing
  if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
    cleaned = 'https://' + cleaned;
  }
  
  // Validate it looks like a URL
  try {
    new URL(cleaned);
  } catch {
    return { normalized: cleaned, error: 'Invalid URL format' };
  }
  
  return { normalized: cleaned };
};

// PKCE utilities
const generateRandomString = (length: number): string => {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues, (v) => charset[v % charset.length]).join('');
};

const sha256 = async (plain: string): Promise<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest('SHA-256', data);
};

const base64UrlEncode = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const generateCodeChallenge = async (verifier: string): Promise<string> => {
  const hash = await sha256(verifier);
  return base64UrlEncode(hash);
};

// State management for OAuth
export const generateAndSaveState = (): string => {
  const state = generateRandomString(32);
  localStorage.setItem(OAUTH_STATE_KEY, state);
  return state;
};

export const verifyState = (state: string): boolean => {
  const savedState = localStorage.getItem(OAUTH_STATE_KEY);
  localStorage.removeItem(OAUTH_STATE_KEY);
  return savedState === state;
};

// OAuth flow preference
export const setOAuthFlow = (flow: OAuthFlow): void => {
  localStorage.setItem(OAUTH_FLOW_KEY, flow);
};

export const getOAuthFlow = (): OAuthFlow => {
  return (localStorage.getItem(OAUTH_FLOW_KEY) as OAuthFlow) || DEFAULT_CONFIG.cognito.oauthFlow;
};

// Build authorize URL (for both preview and actual login)
export const buildAuthorizeUrl = async (): Promise<{ url: string; error?: string }> => {
  const { domain: rawDomain, clientId } = getCognitoConfig();
  const redirectUri = window.location.origin + '/auth/callback';

  const { normalized: cognitoDomain, error: domainError } = normalizeCognitoDomain(rawDomain);
  if (domainError) {
    return { url: '', error: domainError };
  }

  const flow = getOAuthFlow();
  const state = generateAndSaveState();

  if (flow === 'authorization_code') {
    // Authorization Code flow with PKCE
    const codeVerifier = generateRandomString(64);
    localStorage.setItem(PKCE_VERIFIER_KEY, codeVerifier);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    return { url: `${cognitoDomain}/oauth2/authorize?${params.toString()}` };
  }

  if (flow === 'authorization_code_no_pkce') {
    // Authorization Code flow WITHOUT PKCE (for Cognito clients that don't support PKCE)
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
    });

    return { url: `${cognitoDomain}/oauth2/authorize?${params.toString()}` };
  }

  // Implicit flow - response_type=token
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    state,
  });

  return { url: `${cognitoDomain}/oauth2/authorize?${params.toString()}` };
};

// Cognito Hosted UI login
export const getCognitoLoginUrl = async (): Promise<string | null> => {
  const result = await buildAuthorizeUrl();
  if (result.error) {
    return null;
  }
  return result.url;
};

// Run diagnostics on Cognito configuration
export const runCognitoDiagnostics = async (): Promise<DiagnosticsResult> => {
  const { domain: rawDomain, clientId } = getCognitoConfig();

  const { normalized, error: domainError } = normalizeCognitoDomain(rawDomain);

  if (domainError) {
    return { domainValid: false, domainError, normalizedDomain: normalized };
  }

  // Try to fetch OpenID configuration
  try {
    const response = await fetch(`${normalized}/.well-known/openid-configuration`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return {
        domainValid: false,
        normalizedDomain: normalized,
        openidError: `Failed to fetch OpenID config: ${response.status} ${response.statusText}. Check that the Hosted UI domain is correct and enabled.`,
      };
    }

    const config = await response.json();

    // Build preview authorize URL (without state/PKCE for preview only)
    const result = await buildAuthorizeUrl();

    return {
      domainValid: true,
      normalizedDomain: normalized,
      openidConfig: {
        issuer: config.issuer,
        authorization_endpoint: config.authorization_endpoint,
        token_endpoint: config.token_endpoint,
      },
      authorizeUrl: result?.url,
    };
  } catch (error) {
    return {
      domainValid: false,
      normalizedDomain: normalized,
      openidError: `Network error fetching OpenID config: ${error instanceof Error ? error.message : 'Unknown error'}. This usually means the domain is incorrect or CORS is blocking the request.`,
    };
  }
};

// Exchange authorization code for tokens (with or without PKCE)
export const exchangeCodeForTokens = async (code: string): Promise<{ session: AuthSession | null; error?: string }> => {
  const { domain: rawDomain, clientId } = getCognitoConfig();
  const codeVerifier = localStorage.getItem(PKCE_VERIFIER_KEY);
  const redirectUri = window.location.origin + '/auth/callback';
  const flow = getOAuthFlow();

  const { normalized: cognitoDomain, error: domainError } = normalizeCognitoDomain(rawDomain);
  if (domainError) {
    return { session: null, error: domainError };
  }

  const tokenUrl = `${cognitoDomain}/oauth2/token`;

  try {
    // Build request body based on flow type
    const bodyParams: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
    };

    // Only include code_verifier if we're using PKCE flow and have a verifier
    if (flow === 'authorization_code' && codeVerifier) {
      bodyParams.code_verifier = codeVerifier;
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(bodyParams),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetail = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        errorDetail = errorJson.error_description || errorJson.error || errorText;
      } catch {
        // Keep as text
      }
      localStorage.removeItem(PKCE_VERIFIER_KEY);
      return { session: null, error: `Token exchange failed: ${errorDetail}` };
    }

    const data = await response.json();
    localStorage.removeItem(PKCE_VERIFIER_KEY);

    return {
      session: {
        idToken: data.id_token,
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      },
    };
  } catch (error) {
    localStorage.removeItem(PKCE_VERIFIER_KEY);
    return { session: null, error: `Network error: ${error instanceof Error ? error.message : 'Unknown'}` };
  }
};

export const setCognitoConfig = (domain: string, clientId: string): void => {
  localStorage.setItem('spendify_cognito_domain', domain);
  localStorage.setItem('spendify_client_id', clientId);
};

export const getCognitoConfig = (): { domain: string; clientId: string } => {
  const domain = localStorage.getItem('spendify_cognito_domain') || DEFAULT_CONFIG.cognito.domain;
  const clientId = localStorage.getItem('spendify_client_id') || DEFAULT_CONFIG.cognito.clientId;

  return { domain, clientId };
};

export const resetCognitoConfig = (): void => {
  localStorage.removeItem('spendify_cognito_domain');
  localStorage.removeItem('spendify_client_id');
  localStorage.removeItem(OAUTH_FLOW_KEY);
};

export const getRedirectUri = (): string => {
  return window.location.origin + '/auth/callback';
};
