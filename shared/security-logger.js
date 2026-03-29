/**
 * Creates a security event logger.
 *
 * WHY THIS EXISTS:
 * ─────────────────
 * Security logs answer: "Is someone trying to break in?"
 * They are separate from app/event logs because:
 *   - They may be stored LONGER (90+ days for compliance)
 *   - They may be IMMUTABLE (append-only, can't be deleted)
 *   - They feed into security monitoring (SIEM) tools
 *   - They are audited during compliance reviews (SOC2, GDPR)
 *
 * WHAT WE LOG:
 *   - Authentication attempts (success + failure)
 *   - Authorization denials (user tried to access forbidden resource)
 *   - Suspicious activity (too many failures from one IP)
 *   - Admin/privileged actions
 *
 * ALWAYS INCLUDE: ip, username (if available), reason, action
 *
 * USAGE:
 *   const securityLogger = createSecurityLogger(logger);
 *   securityLogger.authSuccess({ username: 'john', ip: '192.168.1.1' });
 *   securityLogger.authFailure({ username: 'john', ip: '192.168.1.1', reason: 'invalid_password' });
 *   securityLogger.accessDenied({ username: 'john', ip: '192.168.1.1', resource: '/admin/users' });
 */
function createSecurityLogger(logger) {
  return {
    authSuccess({ username, ip, role, method = 'password' }) {
      logger.info('SECURITY: Authentication success', {
        log_type: 'security',
        security_event: 'AUTH_SUCCESS',
        username,
        ip,
        role,
        auth_method: method,
      });
    },

    authFailure({ username, ip, reason }) {
      // WARN, not ERROR — a failed login isn't an app error,
      // but it IS noteworthy for security monitoring
      logger.warn('SECURITY: Authentication failed', {
        log_type: 'security',
        security_event: 'AUTH_FAILURE',
        username,
        ip,
        reason,   // 'invalid_password', 'user_not_found', 'account_locked'
      });
    },

    accessDenied({ username, ip, resource, required_role }) {
      logger.warn('SECURITY: Access denied', {
        log_type: 'security',
        security_event: 'ACCESS_DENIED',
        username,
        ip,
        resource,
        required_role,
      });
    },

    suspiciousActivity({ ip, reason, details = {} }) {
      // ERROR — this needs immediate attention
      logger.error('SECURITY: Suspicious activity detected', {
        log_type: 'security',
        security_event: 'SUSPICIOUS_ACTIVITY',
        ip,
        reason,
        ...details,
      });
    },

    adminAction({ username, ip, action, target }) {
      logger.info('SECURITY: Admin action performed', {
        log_type: 'security',
        security_event: 'ADMIN_ACTION',
        username,
        ip,
        action,     // 'delete_user', 'modify_product', 'change_role'
        target,     // resource that was acted upon
      });
    },
  };
}

module.exports = { createSecurityLogger };
