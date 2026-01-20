// Centralized configuration using Vite environment variables
// Required: VITE_COGNITO_DOMAIN, VITE_COGNITO_CLIENT_ID, VITE_API_BASE_URL

export const DEFAULT_CONFIG = {
  cognito: {
    domain: import.meta.env.VITE_COGNITO_DOMAIN as string,
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID as string,
    oauthFlow: 'authorization_code_no_pkce' as const,
  },
  api: {
    baseUrl: import.meta.env.VITE_API_BASE_URL as string,
  },
} as const;

export type OAuthFlowType = typeof DEFAULT_CONFIG.cognito.oauthFlow;
