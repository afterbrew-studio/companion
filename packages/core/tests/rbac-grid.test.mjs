import assert from 'node:assert/strict';
import test from 'node:test';
import { RbacGrid } from '../dist/server/rbac-grid.js';

/**
 * The fold is `base ∪ grants → expand implies → minus revokes → ∩ declared`.
 * Every case below pins one of those steps, because the ordering is the part
 * that is easy to break and impossible to notice: a revoke applied before the
 * implies expansion, or a filter applied before the overrides, both produce a
 * grid that looks plausible and is wrong.
 */

const aclOf = (id, permissions, grants) => ({
  id,
  acl: { permissions: permissions.map((p) => (typeof p === 'string' ? { id: p, title: p } : p)), grants },
});

const widgets = aclOf('widgets', ['widgets:read', 'widgets:manage'], {
  admin: '*',
  maintainer: ['widgets:read'],
});

const gridWith = (sources, overrides) => {
  const grid = new RbacGrid();
  grid.rebuild(sources);
  if (overrides) grid.setOverrides(overrides);
  return grid;
};

test('with no overrides the grid is exactly what the modules grant', () => {
  const grid = gridWith([widgets]);
  assert.deepEqual(grid.permissionsFor('admin').sort(), ['widgets:manage', 'widgets:read']);
  assert.deepEqual(grid.permissionsFor('maintainer'), ['widgets:read']);
  assert.deepEqual(grid.permissionsFor('business'), []);
});

test('credential scope is a ceiling on the live role permissions', () => {
  const grid = gridWith([widgets]);
  const user = {
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    permissionScope: ['widgets:read'],
  };

  assert.equal(grid.allows(user, 'widgets:read'), true);
  assert.equal(grid.allows(user, 'widgets:manage'), false);
  assert.equal(grid.allows({ ...user, permissionScope: [] }, 'widgets:read'), false);
  assert.equal(grid.allows({ ...user, permissionScope: undefined }, 'widgets:manage'), true);
});

test('an instance revoke beats a module grant', () => {
  const grid = gridWith([widgets], {
    roles: ['admin', 'maintainer', 'business'],
    entries: [{ role: 'maintainer', permission: 'widgets:read', mode: 'revoke' }],
  });
  assert.equal(grid.has('maintainer', 'widgets:read'), false);
  // and the provenance still names both mechanisms, so `acl explain` can say why
  const why = grid.explain('maintainer', 'widgets:read');
  assert.equal(why.granted, false);
  assert.equal(why.override, 'revoke');
  assert.deepEqual(
    why.grantedBy.map((g) => g.module),
    ['widgets'],
  );
});

test('a custom role starts empty and is built only from grants', () => {
  const grid = gridWith([widgets], {
    roles: ['admin', 'maintainer', 'business', 'auditor'],
    entries: [{ role: 'auditor', permission: 'widgets:read', mode: 'grant' }],
  });
  assert.deepEqual(grid.permissionsFor('auditor'), ['widgets:read']);
  assert.equal(grid.hasRole('auditor'), true);
  // Module grants only ever name built-in roles, so nothing leaks in.
  assert.equal(grid.explain('auditor', 'widgets:read').grantedBy.length, 0);
  assert.deepEqual(grid.baseline('auditor'), []);
});

test('an unknown role holds nothing rather than throwing', () => {
  const grid = gridWith([widgets]);
  assert.equal(grid.hasRole('nope'), false);
  assert.equal(grid.has('nope', 'widgets:read'), false);
  assert.deepEqual(grid.permissionsFor('nope'), []);
});

test('implies expands through a granted override, and a revoke still wins over it', () => {
  const chain = aclOf('chain', [{ id: 'a:write', title: 'a', implies: ['a:read'] }, 'a:read'], {});
  const granted = gridWith([chain], {
    roles: ['admin'],
    entries: [{ role: 'admin', permission: 'a:write', mode: 'grant' }],
  });
  assert.equal(granted.has('admin', 'a:read'), true, 'implies must expand for an override grant');

  const revoked = gridWith([chain], {
    roles: ['admin'],
    entries: [
      { role: 'admin', permission: 'a:write', mode: 'grant' },
      { role: 'admin', permission: 'a:read', mode: 'revoke' },
    ],
  });
  assert.equal(revoked.has('admin', 'a:read'), false, 'revoke is applied after expansion, so it wins');
  assert.equal(revoked.has('admin', 'a:write'), true);
});

test("a disabled module's permissions leave every role but its override rows survive", () => {
  const overrides = {
    roles: ['admin', 'auditor'],
    entries: [{ role: 'auditor', permission: 'widgets:read', mode: 'grant' }],
  };
  const grid = gridWith([widgets], overrides);
  assert.equal(grid.has('auditor', 'widgets:read'), true);

  // The module is disabled: the kernel rebuilds with it absent from the sources.
  grid.rebuild([]);
  assert.equal(grid.has('auditor', 'widgets:read'), false, 'permission must leave the grid with its module');
  assert.equal(grid.explain('auditor', 'widgets:read').owner, null);

  // Re-enabled: the stored override is still there, so the grant comes back.
  grid.rebuild([widgets]);
  assert.equal(grid.has('auditor', 'widgets:read'), true, 'the override must not have been discarded');
});

test('baseline is what the modules grant, before overrides', () => {
  const grid = gridWith([widgets], {
    roles: ['admin', 'maintainer', 'business'],
    entries: [
      { role: 'maintainer', permission: 'widgets:read', mode: 'revoke' },
      { role: 'maintainer', permission: 'widgets:manage', mode: 'grant' },
    ],
  });
  // The admin surface needs this to tell "granted by default" from "granted
  // here", which is what makes a toggle write `revoke` in one case and `reset`
  // in the other instead of accumulating rows that restate the default.
  assert.deepEqual(grid.baseline('maintainer'), ['widgets:read']);
  assert.deepEqual(grid.permissionsFor('maintainer'), ['widgets:manage']);
});

test('a grant for a permission no enabled module declares is dropped', () => {
  const grid = gridWith([widgets], {
    roles: ['admin'],
    entries: [{ role: 'admin', permission: 'ghost:read', mode: 'grant' }],
  });
  assert.equal(grid.has('admin', 'ghost:read'), false);
});
