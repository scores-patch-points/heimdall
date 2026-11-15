// signal/engines.mjs: the signaling engines a person can install for themselves, so that nobody's nodes
// depend on someone else's server or account. Each engine is a pinned public container image plus how to
// configure it, how to tell it is up, and how to make the first account on it.
//
// What any signaling engine must give the surface (the contract; lib/matrix.mjs is the one adapter today):
//   accounts      a user id, devices under it, and a way for another device to prove "I am that user"
//   networks      a shared space whose opener alone can remove others, enforced by the server
//   key delivery  device-to-device messages, end-to-end encrypted, deleted once delivered
//   sync          membership and device-list changes pushed to each device
//   federation    nodes on different servers can share one network
// Matrix homeservers give all five. Tools that give only some (a bare WebRTC signaling server, a Nostr
// relay, ntfy, XMPP without MUC power levels) cannot carry a network alone; see CODECS.md section 10.
import crypto from 'node:crypto';

const rnd = (n = 24) => crypto.randomBytes(n).toString('base64url');

export const ENGINES = {
  synapse: {
    image: 'matrixdotorg/synapse:v1.120.0',          // pinned; published 2024-11-26
    internalPort: 8008,
    dataMount: '/data',
    // generate a config, then append the settings the surface relies on
    async configure({ docker, dir, name, federation }) {
      await docker(['run', '--rm', '-v', `${dir}/data:/data`, '-e', `SYNAPSE_SERVER_NAME=${name}`, '-e', 'SYNAPSE_REPORT_STATS=no', this.image, 'generate']);
      const fs = await import('node:fs');
      const yaml = `${dir}/data/homeserver.yaml`;
      const secret = fs.readFileSync(yaml, 'utf8').match(/registration_shared_secret: "(.*)"/)[1];
      fs.appendFileSync(yaml, [
        '', '# --- written by heimdall signal install ---',
        federation ? '' : 'federation_domain_whitelist: []',
        'rc_message: {per_second: 50, burst_count: 200}',
        'rc_login: {address: {per_second: 5, burst_count: 20}, account: {per_second: 5, burst_count: 20}, failed_attempts: {per_second: 1, burst_count: 10}}',
        '',
      ].join('\n'));
      return { registration: { kind: 'synapse-shared-secret', secret } };
    },
    runArgs({ dir }) { return ['-v', `${dir}/data:/data`]; },
  },
  conduit: {
    image: 'matrixconduit/matrix-conduit:v0.10.15',  // pinned; published 2026-09-30
    internalPort: 6167,
    async configure({ name, federation }) {
      return { registration: { kind: 'registration-token', token: rnd() }, env: { name, federation } };
    },
    runArgs({ dir, name, federation, registration }) {
      return [
        '-v', `${dir}/data:/var/lib/matrix-conduit/`,
        '-e', `CONDUIT_SERVER_NAME=${name}`, '-e', 'CONDUIT_DATABASE_PATH=/var/lib/matrix-conduit/', '-e', 'CONDUIT_DATABASE_BACKEND=rocksdb',
        '-e', 'CONDUIT_PORT=6167', '-e', 'CONDUIT_ADDRESS=0.0.0.0', '-e', 'CONDUIT_MAX_REQUEST_SIZE=20000000',
        '-e', 'CONDUIT_ALLOW_REGISTRATION=true', '-e', `CONDUIT_REGISTRATION_TOKEN=${registration.token}`,
        '-e', `CONDUIT_ALLOW_FEDERATION=${federation ? 'true' : 'false'}`, '-e', "CONDUIT_TRUSTED_SERVERS=[]", '-e', 'CONDUIT_CONFIG=',
      ];
    },
  },
};
