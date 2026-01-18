import { useEffect } from 'react';
import { useUserStatus } from '@/hooks/useUserStatus';
import { isAuthenticated } from '@/lib/auth';

/**
 * This component initializes the user status on app start.
 * It should be rendered once inside the app, after auth is available.
 */
const UserStatusInitializer = () => {
  const { fetchStatus } = useUserStatus();

  useEffect(() => {
    if (isAuthenticated()) {
      fetchStatus();
    }
  }, [fetchStatus]);

  return null;
};

export default UserStatusInitializer;
