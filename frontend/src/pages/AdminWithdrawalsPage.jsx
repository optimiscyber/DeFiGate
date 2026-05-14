import React, { useEffect, useState } from 'react';
import { apiUrl } from '../api';

const AdminWithdrawalsPage = ({ user }) => {
  const [withdrawals, setWithdrawals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [rejectionReasons, setRejectionReasons] = useState({});

  const token = localStorage.getItem('authToken');

  const fetchPending = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/admin/withdrawals/pending'), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (data.ok) {
        setWithdrawals(data.data.withdrawals || []);
      }
    } catch (error) {
      console.error('Failed to fetch pending withdrawals', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPending();
  }, []);

  const handleAction = async (transactionId, action) => {
    const body = action === 'reject' ? { reason: rejectionReasons[transactionId] || 'Manual rejection' } : {};
    try {
      const res = await fetch(apiUrl(`/admin/withdrawals/${transactionId}/${action}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        fetchPending();
        alert(`Withdrawal ${action}ed successfully`);
      } else {
        alert(data.error || `Failed to ${action} withdrawal`);
      }
    } catch (error) {
      alert(error.message || `Failed to ${action} withdrawal`);
    }
  };

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2>Pending Withdrawals</h2>
        <p>Approve or reject withdrawal requests that are waiting for review.</p>
      </div>

      <div className="admin-table-overflow">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Txn ID</th>
              <th>User</th>
              <th>Amount</th>
              <th>Recipient</th>
              <th>Requested</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {withdrawals.map((withdrawal) => (
              <tr key={withdrawal.id || withdrawal.transaction_id}>
                <td>{withdrawal.id || withdrawal.transaction_id}</td>
                <td>{withdrawal.user_id || withdrawal.user?.email || 'Unknown'}</td>
                <td>{withdrawal.amount} {withdrawal.asset || 'USDC'}</td>
                <td>{withdrawal.recipient_address || withdrawal.recipient_address || 'N/A'}</td>
                <td>{new Date(withdrawal.created_at).toLocaleString()}</td>
                <td>
                  <div className="admin-actions-cell">
                    <button className="btn btn-primary" onClick={() => handleAction(withdrawal.id || withdrawal.transaction_id, 'approve')}>
                      Approve
                    </button>
                    <button className="btn btn-secondary" onClick={() => handleAction(withdrawal.id || withdrawal.transaction_id, 'reject')}>
                      Reject
                    </button>
                  </div>
                  <textarea
                    rows="2"
                    placeholder="Rejection reason"
                    value={rejectionReasons[withdrawal.id || withdrawal.transaction_id] || ''}
                    onChange={(e) => {
                      setRejectionReasons((prev) => ({
                        ...prev,
                        [withdrawal.id || withdrawal.transaction_id]: e.target.value,
                      }));
                    }}
                    style={{
                      width: '100%',
                      marginTop: '10px',
                      padding: '10px',
                      borderRadius: '10px',
                      border: '1px solid var(--border)',
                      resize: 'vertical',
                    }}
                  />
                </td>
              </tr>
            ))}
            {withdrawals.length === 0 && (
              <tr>
                <td colSpan="6">No pending withdrawals found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {loading && <p className="loading">Loading withdrawals…</p>}
    </div>
  );
};

export default AdminWithdrawalsPage;
