import { useState, useEffect } from 'react';
import { apiUrl } from '../api';

export function useBalance(userId) {
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchBalance = async () => {
    if (!userId) return;

    setLoading(true);
    setError(null);

    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/user/me'), {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch balance');
      }

      const data = await response.json();
      if (data.ok && data.data?.user) {
        setBalance(Number(data.data.user.available_balance || 0));
      }
    } catch (err) {
      console.error('Balance fetch error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBalance();
  }, [userId]);

  return { balance, loading, error, refetch: fetchBalance };
}