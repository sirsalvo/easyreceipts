// Cross-tab authentication broadcast using BroadcastChannel API
// This allows login to happen in a new tab and notify the original tab when complete

const AUTH_CHANNEL_NAME = 'spendify_auth_channel';

export interface AuthBroadcastMessage {
  type: 'AUTH_SUCCESS' | 'AUTH_FAILURE';
  timestamp: number;
}

let channel: BroadcastChannel | null = null;

const getChannel = (): BroadcastChannel => {
  if (!channel) {
    channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
  }
  return channel;
};

// Broadcast authentication success to other tabs
export const broadcastAuthSuccess = (): void => {
  try {
    getChannel().postMessage({
      type: 'AUTH_SUCCESS',
      timestamp: Date.now(),
    } as AuthBroadcastMessage);
  } catch (error) {
    console.warn('Failed to broadcast auth success:', error);
  }
};

// Broadcast authentication failure to other tabs
export const broadcastAuthFailure = (): void => {
  try {
    getChannel().postMessage({
      type: 'AUTH_FAILURE',
      timestamp: Date.now(),
    } as AuthBroadcastMessage);
  } catch (error) {
    console.warn('Failed to broadcast auth failure:', error);
  }
};

// Listen for authentication events from other tabs
export const onAuthBroadcast = (
  callback: (message: AuthBroadcastMessage) => void
): (() => void) => {
  const handleMessage = (event: MessageEvent<AuthBroadcastMessage>) => {
    callback(event.data);
  };

  getChannel().addEventListener('message', handleMessage);

  return () => {
    getChannel().removeEventListener('message', handleMessage);
  };
};

// Check if we're in a popup/new tab opened for login
export const isLoginPopup = (): boolean => {
  return sessionStorage.getItem('spendify_login_popup') === 'true';
};

// Mark this tab as a login popup
export const markAsLoginPopup = (): void => {
  sessionStorage.setItem('spendify_login_popup', 'true');
};

// Clear login popup marker
export const clearLoginPopupMarker = (): void => {
  sessionStorage.removeItem('spendify_login_popup');
};

// Close this tab if it's a login popup
export const closeIfLoginPopup = (): void => {
  if (isLoginPopup()) {
    clearLoginPopupMarker();
    // Try to close the tab - this may not work if the tab wasn't opened via script
    window.close();
  }
};
