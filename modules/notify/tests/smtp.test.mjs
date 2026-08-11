import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  assertEmailAddress,
  assertPlausibleSmtpHost,
  assertPublicSmtpHost,
  buildEmail,
  deliverEmail,
} from '../dist/api/smtp.js';
import { smtpNotificationProvider } from '../dist/api/smtp-provider.js';

/**
 * Scripted mock SMTP server. Default behaviour is a compliant plaintext
 * submission server; `behave(line, connectionIndex)` may return a reply line to
 * override any command, and `ehloReply` replaces the capability listing.
 */
function startMockSmtp({ behave, ehloReply, dataReply } = {}) {
  const transcripts = [];
  let connections = 0;
  const server = createServer((socket) => {
    const received = [];
    const index = connections++;
    transcripts[index] = received;
    let buffer = '';
    let inData = false;
    socket.write('220 mock ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let at;
      while ((at = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        received.push(line);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write(`${dataReply ?? '250 queued'}\r\n`);
          }
          continue;
        }
        const custom = behave?.(line, index);
        if (custom) {
          socket.write(`${custom}\r\n`);
          continue;
        }
        if (/^EHLO /i.test(line)) socket.write(`${ehloReply ?? '250-mock.example\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000000'}\r\n`);
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 ok\r\n');
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 ok\r\n');
        else if (/^RCPT TO:/i.test(line)) socket.write('250 ok\r\n');
        else if (/^DATA$/i.test(line)) {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (/^QUIT$/i.test(line)) {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('500 unrecognised\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        transcripts,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function endpoint(port, overrides = {}) {
  return {
    host: 'mail.example.com',
    address: '127.0.0.1',
    port,
    secure: false,
    username: 'notifier',
    password: 's3cret-pass',
    ...overrides,
  };
}

const MESSAGE = {
  from: 'companion@example.com',
  to: ['dev@example.com', 'ops@example.com'],
  subject: 'Deploy finished',
  text: 'All checks passed.\n.stuffed line survives\nhttps://companion.corp/#/x',
};

const FAST = { allowPlaintext: true, retryDelayMs: 25 };

/** QUIT is fire-and-forget for the client, so the server may see it a beat
 * after the delivery outcome resolves. */
async function eventually(check) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check());
}

// ---------- happy path ----------

test('a full submission: greeting, EHLO, AUTH PLAIN, envelope, dot-stuffed DATA, QUIT', async () => {
  const server = await startMockSmtp();
  try {
    const outcome = await deliverEmail(endpoint(server.port), MESSAGE, FAST);
    assert.deepEqual(outcome, { ok: true, httpStatus: 250, error: null, attempts: 1 });

    const lines = server.transcripts[0];
    await eventually(() => lines[lines.length - 1] === 'QUIT');
    assert.equal(lines[0], 'EHLO companion');
    const expectedAuth = `AUTH PLAIN ${Buffer.from('\u0000notifier\u0000s3cret-pass', 'utf8').toString('base64')}`;
    assert.equal(lines[1], expectedAuth);
    assert.equal(lines[2], 'MAIL FROM:<companion@example.com>');
    assert.equal(lines[3], 'RCPT TO:<dev@example.com>');
    assert.equal(lines[4], 'RCPT TO:<ops@example.com>');
    assert.equal(lines[5], 'DATA');
    assert.equal(lines[lines.length - 1], 'QUIT');
    assert.equal(lines[lines.length - 2], '.');

    const data = lines.slice(6, -2);
    assert.ok(data.includes('Subject: Deploy finished'));
    assert.ok(data.includes('To: dev@example.com, ops@example.com'));
    // The line beginning with '.' is doubled so it cannot terminate DATA early.
    assert.ok(data.includes('..stuffed line survives'));
    assert.ok(data.includes('All checks passed.'));
  } finally {
    await server.close();
  }
});

test('AUTH LOGIN is used when the server only offers LOGIN', async () => {
  let state = null;
  const server = await startMockSmtp({
    ehloReply: '250-mock.example\r\n250 AUTH LOGIN',
    behave: (line) => {
      if (/^AUTH LOGIN$/i.test(line)) {
        state = 'user';
        return '334 VXNlcm5hbWU6';
      }
      if (state === 'user') {
        state = 'pass';
        return '334 UGFzc3dvcmQ6';
      }
      if (state === 'pass') {
        state = null;
        return '235 ok';
      }
      return null;
    },
  });
  try {
    const outcome = await deliverEmail(endpoint(server.port), MESSAGE, FAST);
    assert.equal(outcome.ok, true);
    const lines = server.transcripts[0];
    assert.ok(lines.includes('AUTH LOGIN'));
    assert.ok(lines.includes(Buffer.from('notifier', 'utf8').toString('base64')));
    assert.ok(lines.includes(Buffer.from('s3cret-pass', 'utf8').toString('base64')));
  } finally {
    await server.close();
  }
});

// ---------- STARTTLS ----------

test('a server that does not offer STARTTLS gets no credentials and no retry', async () => {
  const server = await startMockSmtp({ ehloReply: '250-mock.example\r\n250 AUTH PLAIN LOGIN' });
  try {
    const outcome = await deliverEmail(endpoint(server.port), MESSAGE, { retryDelayMs: 25 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, 1);
    assert.match(outcome.error, /STARTTLS/);
    assert.equal(server.transcripts.length, 1);
    const everything = server.transcripts[0].join('\n');
    assert.doesNotMatch(everything, /AUTH/);
    assert.doesNotMatch(everything, /s3cret-pass/);
  } finally {
    await server.close();
  }
});

// ---------- retry semantics ----------

test('a 451 is transient: retried once and delivered on the second connection', async () => {
  const server = await startMockSmtp({
    behave: (line, index) => (index === 0 && /^MAIL FROM:/i.test(line) ? '451 greylisted, try later' : null),
  });
  try {
    const outcome = await deliverEmail(endpoint(server.port), MESSAGE, FAST);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 2);
    assert.equal(server.transcripts.length, 2);
  } finally {
    await server.close();
  }
});

test('a 550 is permanent: reported after one attempt, never retried', async () => {
  const server = await startMockSmtp({
    behave: (line) => (/^RCPT TO:/i.test(line) ? '550 no such mailbox' : null),
  });
  try {
    const outcome = await deliverEmail(endpoint(server.port), MESSAGE, FAST);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.httpStatus, 550);
    assert.equal(outcome.attempts, 1);
    assert.match(outcome.error, /no such mailbox/);
    assert.equal(server.transcripts.length, 1);
  } finally {
    await server.close();
  }
});

test('a connection failure is retried and then reported, never thrown', async () => {
  const server = await startMockSmtp();
  const closedPort = server.port;
  await server.close();
  const outcome = await deliverEmail(endpoint(closedPort), MESSAGE, FAST);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.httpStatus, null);
  assert.equal(outcome.attempts, 2);
});

// ---------- message shape ----------

test('a non-ASCII subject travels as an RFC 2047 encoded word', () => {
  const email = buildEmail({ ...MESSAGE, subject: 'Wdrożenie zakończone' });
  const subject = email.split('\r\n').find((line) => line.startsWith('Subject: '));
  assert.match(subject, /^Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
});

test('header values cannot smuggle extra lines', () => {
  const email = buildEmail({ ...MESSAGE, subject: 'hi\r\nBcc: evil@example.com' });
  assert.doesNotMatch(email, /^Bcc:/m);
});

// ---------- host and address validation ----------

test('SMTP hosts cannot be local, private, or reserved', async () => {
  for (const host of ['localhost', 'mail.localhost', 'smtp.local', 'relay.internal', 'box.home.arpa', '127.0.0.1', '10.1.2.3', '169.254.169.254', '::1']) {
    assert.throws(() => assertPlausibleSmtpHost(host), /public|plain hostname/i, host);
  }
  assert.equal(assertPlausibleSmtpHost('SMTP.Example.Com '), 'smtp.example.com');
  assert.equal(assertPlausibleSmtpHost('1.1.1.1'), '1.1.1.1');
  await assert.rejects(
    assertPublicSmtpHost('mail.example.com', async () => ['10.0.0.4']),
    /public addresses/,
  );
  await assert.rejects(
    assertPublicSmtpHost('mail.example.com', async () => ['93.184.216.34', '127.0.0.1']),
    /public addresses/,
  );
  assert.deepEqual(await assertPublicSmtpHost('mail.example.com', async () => ['93.184.216.34']), ['93.184.216.34']);
});

test('addresses that could carry SMTP or header injection are refused', () => {
  assert.equal(assertEmailAddress(' dev@example.com ', 'Recipient'), 'dev@example.com');
  for (const bad of ['dev @example.com', 'dev@exa mple.com', 'dev@example.com>\r\nRCPT TO:<evil@x.example', '<dev@example.com>', 'dev', 'dev@']) {
    assert.throws(() => assertEmailAddress(bad, 'Recipient'), /plain email address/, bad);
  }
});

// ---------- provider config ----------

const GOOD_CONFIG = {
  host: 'smtp.example.com',
  port: '587',
  secure: false,
  username: 'notifier',
  from: 'companion@example.com',
  to: 'dev@example.com, ops@example.com',
};

function validate(config, secrets = { password: 'pw' }) {
  smtpNotificationProvider().validateConfig(config, (key) => secrets[key] ?? null);
}

test('provider connections reject unsafe or incoherent SMTP settings before a secret is stored', () => {
  assert.doesNotThrow(() => validate(GOOD_CONFIG));
  assert.throws(() => validate({ ...GOOD_CONFIG, host: 'localhost' }), /publicly reachable/);
  assert.throws(() => validate({ ...GOOD_CONFIG, host: '10.0.0.2' }), /public address/);
  assert.throws(() => validate({ ...GOOD_CONFIG, host: '' }), /SMTP host is required/);
  assert.throws(() => validate({ ...GOOD_CONFIG, port: '0' }), /between 1 and 65535/);
  assert.throws(() => validate({ ...GOOD_CONFIG, port: 'abc' }), /between 1 and 65535/);
  assert.throws(() => validate(GOOD_CONFIG, {}), /password is required/);
  assert.throws(() => validate({ ...GOOD_CONFIG, username: '' }), /username is required/);
  assert.throws(() => validate({ ...GOOD_CONFIG, from: 'not-an-address' }), /plain email address/);
  assert.throws(() => validate({ ...GOOD_CONFIG, to: ' , ' }), /Recipients is required|at least one/i);
  assert.throws(() => validate({ ...GOOD_CONFIG, eventKinds: 'finishd' }), /Unsupported event kind/);
});

test('delivery refuses a host that resolves privately, before any socket opens', async () => {
  const provider = smtpNotificationProvider(async () => ['192.168.1.20']);
  const connection = {
    record: { id: 'ic-smtp', providerId: 'smtp.email', name: 'Ops mail', ownerId: null, scope: { kind: 'instance' }, config: GOOD_CONFIG, configuredSecrets: ['password'] },
    secret: (key) => (key === 'password' ? 'pw' : null),
  };
  const outcome = await provider.notify(connection, {
    id: 'n1',
    kind: 'info',
    title: 'hello',
    body: 'world',
    workspaceId: null,
    repo: null,
    href: null,
    url: null,
    createdAt: Date.now(),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 0);
  assert.match(outcome.error, /public addresses/);
});
