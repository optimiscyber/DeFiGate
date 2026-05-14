import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';

const AdminDashboard = ({ user }) => {
  const [activeTab, setActiveTab] = useState('overview');
  const [reconciliationData, setReconciliationData] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user?.role === 'admin') {
      loadDashboardData();
    }
  }, [user]);

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      // Load reconciliation data only for admin users
      if (user?.role === 'admin') {
        const reconcileResponse = await fetch(apiUrl('/admin/reconcile'), {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ autoRepair: false }) // Don't auto-repair on dashboard load
        });

        if (reconcileResponse.ok) {
          const reconcileResult = await reconcileResponse.json();
          setReconciliationData(reconcileResult.data);
        }

        const logsResponse = await fetch(apiUrl('/admin/audit-logs?limit=50'), {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
          },
        });

        if (logsResponse.ok) {
          const logsResult = await logsResponse.json();
          setAuditLogs(logsResult.data.logs || []);
        }
      }
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const runReconciliation = async (autoRepair = false) => {
    setLoading(true);
    try {
      const response = await fetch(apiUrl('/admin/reconcile'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ autoRepair })
      });

      const result = await response.json();
      if (response.ok) {
        setReconciliationData(result.data);
        alert(autoRepair ? 'Reconciliation completed with auto-repair' : 'Reconciliation completed');
      } else {
        alert('Reconciliation failed: ' + result.error);
      }
    } catch (error) {
      alert('Reconciliation error: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  if (!['admin', 'support'].includes(user?.role)) {
    return (
      <div className="dashboard-container">
        <div className="error-message">
          <h2>Access Denied</h2>
          <p>Admin access required</p>
        </div>
      </div>
    );
  }

  const isAdmin = user?.role === 'admin';

  return (
    <div className="dashboard-container">
      <div style={{ marginBottom: '24px' }}>
        <h1>Admin Dashboard</h1>
        <p>Monitor system health and manage operations</p>
        {!isAdmin && (
          <p style={{ marginTop: '8px', color: 'var(--text-muted)' }}>
            Limited support access. Reconciliation and audit visibility are reserved for administrators.
          </p>
        )}
      </div>

      {/* Tab Navigation */}
      <div style={{ marginBottom: '24px', borderBottom: '1px solid var(--border)' }}>
        <button
          className={`tab-button ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`tab-button ${activeTab === 'reconciliation' ? 'active' : ''}`}
          onClick={() => isAdmin && setActiveTab('reconciliation')}
          disabled={!isAdmin}
        >
          Reconciliation
        </button>
        <button
          className={`tab-button ${activeTab === 'audit' ? 'active' : ''}`}
          onClick={() => isAdmin && setActiveTab('audit')}
          disabled={!isAdmin}
        >
          Audit Logs
        </button>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="admin-overview">
          <div className="stats-grid">
            <div className="stat-card">
              <h3>Total Wallets</h3>
              <p className="stat-number">{reconciliationData?.reconciliation?.total_wallets || 0}</p>
            </div>
            <div className="stat-card">
              <h3>Healthy Wallets</h3>
              <p className="stat-number green">{reconciliationData?.reconciliation?.matched || 0}</p>
            </div>
            <div className="stat-card">
              <h3>Mismatches</h3>
              <p className="stat-number red">{reconciliationData?.reconciliation?.mismatches || 0}</p>
            </div>
            <div className="stat-card">
              <h3>Errors</h3>
              <p className="stat-number yellow">{reconciliationData?.reconciliation?.errors || 0}</p>
            </div>
          </div>

          <div className="quick-actions">
            <button
              className="btn btn-primary"
              onClick={() => runReconciliation(false)}
              disabled={loading}
            >
              {loading ? 'Running...' : 'Run Reconciliation'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => runReconciliation(true)}
              disabled={loading}
            >
              {loading ? 'Running...' : 'Run with Auto-Repair'}
            </button>
          </div>
        </div>
      )}

      {/* Reconciliation Tab */}
      {activeTab === 'reconciliation' && (
        <div className="reconciliation-details">
          <h2>Reconciliation Results</h2>
          {!isAdmin ? (
            <p>Reconciliation controls are restricted to administrators.</p>
          ) : (
            <>
              {reconciliationData?.reconciliation?.results?.map((result, index) => (
                <div key={index} className={`result-card ${result.status}`}>
                  <div className="result-header">
                    <span className="wallet-address">{result.address}</span>
                    <span className={`status-badge ${result.status}`}>
                      {result.status}
                    </span>
                  </div>

                  {result.status === 'mismatch' && (
                    <div className="mismatch-details">
                      <div className="balance-comparison">
                        <div>
                          <label>Blockchain:</label>
                          <span>{result.blockchain_balance?.toFixed(2)} USDC</span>
                        </div>
                        <div>
                          <label>App:</label>
                          <span>{result.app_balance?.toFixed(2)} USDC</span>
                        </div>
                        <div>
                          <label>Difference:</label>
                          <span className={result.difference > 0 ? 'positive' : 'negative'}>
                            {result.difference > 0 ? '+' : ''}{result.difference?.toFixed(2)} USDC
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {result.error && (
                    <div className="error-details">
                      <p>Error: {result.error}</p>
                    </div>
                  )}
                </div>
              ))}

              {(!reconciliationData?.reconciliation?.results || reconciliationData.reconciliation.results.length === 0) && (
                <p>No reconciliation data available. Run reconciliation first.</p>
              )}
            </>
          )}
        </div>
      )}

      {/* Audit Logs Tab */}
      {activeTab === 'audit' && (
        <div className="audit-logs">
          <h2>Audit Logs</h2>

          {!isAdmin ? (
            <p>Audit log viewing is restricted to administrators.</p>
          ) : (
            <div className="logs-table">
              <div className="table-header">
                <div>Action</div>
                <div>User</div>
                <div>Amount</div>
                <div>Timestamp</div>
              </div>

              {auditLogs.map((log, index) => (
                <div key={index} className="table-row">
                  <div className="action">{log.action}</div>
                  <div className="user">{log.user_id || 'System'}</div>
                  <div className="amount">
                    {log.amount && log.asset ? `${log.amount} ${log.asset}` : '-'}
                  </div>
                  <div className="timestamp">
                    {new Date(log.created_at).toLocaleString()}
                  </div>
                </div>
              ))}

              {auditLogs.length === 0 && (
                <p>No audit logs available.</p>
              )}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .tab-button {
          background: none;
          border: none;
          padding: 12px 24px;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          font-weight: 500;
        }

        .tab-button.active {
          border-bottom-color: var(--primary);
          color: var(--primary);
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          margin-bottom: 24px;
        }

        .stat-card {
          background: var(--bg-secondary);
          padding: 20px;
          border-radius: 8px;
          border: 1px solid var(--border);
          text-align: center;
        }

        .stat-card h3 {
          margin: 0 0 8px 0;
          font-size: 14px;
          color: var(--text-secondary);
        }

        .stat-number {
          font-size: 32px;
          font-weight: bold;
          margin: 0;
        }

        .stat-number.green { color: #10b981; }
        .stat-number.red { color: #ef4444; }
        .stat-number.yellow { color: #f59e0b; }

        .quick-actions {
          display: flex;
          gap: 12px;
        }

        .result-card {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 12px;
        }

        .result-card.matched { border-color: #10b981; }
        .result-card.mismatch { border-color: #ef4444; }
        .result-card.error { border-color: #f59e0b; }

        .result-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .wallet-address {
          font-family: monospace;
          font-size: 14px;
        }

        .status-badge {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }

        .status-badge.matched { background: #10b981; color: white; }
        .status-badge.mismatch { background: #ef4444; color: white; }
        .status-badge.error { background: #f59e0b; color: white; }

        .balance-comparison {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
        }

        .balance-comparison > div {
          text-align: center;
        }

        .balance-comparison label {
          display: block;
          font-size: 12px;
          color: var(--text-secondary);
          margin-bottom: 4px;
        }

        .positive { color: #10b981; }
        .negative { color: #ef4444; }

        .logs-table {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
        }

        .table-header {
          display: grid;
          grid-template-columns: 2fr 2fr 1fr 2fr;
          gap: 16px;
          padding: 12px 16px;
          background: var(--bg-primary);
          border-bottom: 1px solid var(--border);
          font-weight: 600;
          font-size: 14px;
        }

        .table-row {
          display: grid;
          grid-template-columns: 2fr 2fr 1fr 2fr;
          gap: 16px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-light);
          font-size: 14px;
        }

        .table-row:last-child {
          border-bottom: none;
        }

        .action {
          font-weight: 500;
          text-transform: capitalize;
          font-size: 12px;
        }

        .user {
          font-family: monospace;
          font-size: 12px;
        }

        .timestamp {
          color: var(--text-secondary);
          font-size: 12px;
        }
      `}</style>
    </div>
  );
};

export default AdminDashboard;