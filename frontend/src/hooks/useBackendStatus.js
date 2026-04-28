import { useState, useEffect } from 'react';
import { apiUrl } from '../api';

export function useBackendStatus() {
  const [backendStatus, setBackendStatus] = useState('checking'); // 'online', 'offline', 'checking'

  useEffect(() => {
    const checkBackendStatus = async () => {
      try {
        const response = await fetch(apiUrl('/health'));
        if (response.ok) {
          setBackendStatus('online');
        } else {
          setBackendStatus('offline');
        }
      } catch (error) {
        setBackendStatus('offline');
      }
    };

    checkBackendStatus();
    const interval = setInterval(checkBackendStatus, 30000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, []);

  return backendStatus;
}