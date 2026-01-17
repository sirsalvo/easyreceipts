// Centralized configuration with default values
// These defaults are used when localStorage is empty

export const DEFAULT_CONFIG = {
  cognito: {
    domain: 'easyreceipts-dev-ui-20260114.auth.eu-central-1.amazoncognito.com',
    clientId: '64v1iehaqubrhi1s8oqkvfvbt6',
    oauthFlow: 'authorization_code_no_pkce' as const,
  },
  api: {
    baseUrl: 'https://uwpd0mb0ji.execute-api.eu-central-1.amazonaws.com',
  },
} as const;

export type OAuthFlowType = typeof DEFAULT_CONFIG.cognito.oauthFlow;
