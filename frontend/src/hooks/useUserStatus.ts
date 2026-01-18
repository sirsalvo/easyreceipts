import { useState, useEffect, useCallback } from 'react';
import { getUserState, subscribeToUserState, setUserState, clearUserState, UserStatus } from '@/lib/userStore';
import { getUserStatus } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';

export const useUserStatus = () => {
  const [state, setState] = useState(getUserState());

  useEffect(() => {
    const unsubscribe = subscribeToUserState(() => {
      setState(getUserState());
    });
    return unsubscribe;
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!isAuthenticated()) {
      clearUserState();
      return;
    }

    setUserState({ loading: true });

    try {
      const data = await getUserStatus();
      setUserState({
        status: data.status,
        daysRemaining: data.daysRemaining ?? null,
        loading: false,
      });
    } catch (error) {
      console.error('Failed to fetch user status:', error);
      setUserState({ loading: false });
    }
  }, []);

  const clearStatus = useCallback(() => {
    clearUserState();
  }, []);

  return {
    status: state.status as UserStatus,
    daysRemaining: state.daysRemaining,
    loading: state.loading,
    fetchStatus,
    clearStatus,
  };
};
