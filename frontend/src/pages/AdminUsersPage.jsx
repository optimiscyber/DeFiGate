import React, { useEffect, useState } from 'react';
import { apiUrl } from '../api';

const AdminUsersPage = ({ user }) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [roleChanges, setRoleChanges] = useState({});

  const token = localStorage.getItem('authToken');
  const canUpdateRoles = user?.role === 'admin';

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/admin/users?limit=200'), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (data.ok) {
        setUsers(data.data.users || []);
      }
    } catch (error) {
      console.error('Failed to fetch users', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const updateUserRole = async (userId, newRole) => {
    if (!canUpdateRoles) return;
    try {
      const res = await fetch(apiUrl(`/admin/users/${userId}/role`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (data.ok) {
        fetchUsers();
        alert('User role updated');
      } else {
        alert(data.error || 'Failed to update role');
      }
    } catch (error) {
      alert(error.message || 'Failed to update role');
    }
  };

  const changeFreezeState = async (userId, action) => {
    try {
      const res = await fetch(apiUrl(`/admin/users/${userId}/${action}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: action === 'freeze' ? 'Manual review requested' : undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        fetchUsers();
        alert(`User ${action}d successfully`);
      } else {
        alert(data.error || `Failed to ${action} user`);
      }
    } catch (error) {
      alert(error.message || `Failed to ${action} user`);
    }
  };

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2>User Management</h2>
        <p>View system users and apply support-safe account controls.</p>
      </div>

      <div className="admin-table-overflow">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((userRecord) => (
              <tr key={userRecord.id}>
                <td>{userRecord.email}</td>
                <td>
                  {canUpdateRoles ? (
                    <select
                      value={roleChanges[userRecord.id] ?? userRecord.role}
                      onChange={(e) => {
                        const value = e.target.value;
                        setRoleChanges((prev) => ({ ...prev, [userRecord.id]: value }));
                      }}
                      onBlur={(e) => updateUserRole(userRecord.id, e.target.value)}
                    >
                      <option value="user">user</option>
                      <option value="support">support</option>
                      <option value="admin">admin</option>
                    </select>
                  ) : (
                    userRecord.role
                  )}
                </td>
                <td>{userRecord.is_frozen ? 'Frozen' : 'Active'}</td>
                <td>{new Date(userRecord.created_at).toLocaleString()}</td>
                <td className="admin-actions-cell">
                  {userRecord.is_frozen ? (
                    <button className="btn btn-secondary" onClick={() => changeFreezeState(userRecord.id, 'unfreeze')}>
                      Unfreeze
                    </button>
                  ) : (
                    <button className="btn btn-secondary" onClick={() => changeFreezeState(userRecord.id, 'freeze')}>
                      Freeze
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan="5">No users found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {loading && <p className="loading">Loading users…</p>}
    </div>
  );
};

export default AdminUsersPage;
