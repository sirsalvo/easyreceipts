// Global store for user subscription status
export type UserStatus = 'trial' | 'active' | 'expired' | null;

interface UserState {
  status: UserStatus;
  daysRemaining: number | null;
  loading: boolean;
}

let state: UserState = {
  status: null,
  daysRemaining: null,
  loading: false,
};

type Listener = () => void;
const listeners: Set<Listener> = new Set();

const notify = () => {
  listeners.forEach((listener) => listener());
};

export const getUserState = (): UserState => state;

export const setUserState = (newState: Partial<UserState>) => {
  state = { ...state, ...newState };
  notify();
};

export const clearUserState = () => {
  state = {
    status: null,
    daysRemaining: null,
    loading: false,
  };
  notify();
};

export const subscribeToUserState = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
