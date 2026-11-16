import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLoopbackRelayPlan, RelayPlanError } from './loopback-relay.mjs';
const id = 'a'.repeat(64),
  image = 'sha256:' + 'b'.repeat(64),
  network = 'c'.repeat(64);
function fixture() {
  return {
    expectedContainerId: id,
    expectedImageId: image,
    listenPort: 3101,
    containerInspect: {
      Id: id,
      Image: image,
      State: { Running: true },
      Config: {
        Env: [
          'HOST=0.0.0.0',
          'PORT=3101',
          'PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3101',
          'BETTER_AUTH_SECRET=never-copy-this-secret',
        ],
      },
      HostConfig: {
        Privileged: false,
        PublishAllPorts: false,
        PortBindings: {},
        Memory: 2147483648,
        NanoCpus: 1000000000,
        PidMode: '',
        IpcMode: 'private',
        UsernsMode: '',
        CapAdd: null,
        Devices: [],
        DeviceRequests: null,
        DeviceCgroupRules: null,
        VolumesFrom: null,
        MemorySwap: 2147483648,
        PidsLimit: 256,
        SecurityOpt: ['no-new-privileges:true'],
      },
      Mounts: [
        {
          Type: 'bind',
          Destination: '/paperclip',
          Source: '/var/lib/baink-paperclip/data',
        },
      ],
      NetworkSettings: {
        Ports: { '3101/tcp': null },
        Networks: { pilot: { NetworkID: network, IPAddress: '172.30.0.2' } },
      },
    },
    networkInspect: {
      Id: network,
      Internal: true,
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: '172.30.0.0/16' }] },
      Containers: { [id]: { IPv4Address: '172.30.0.2/16' } },
    },
  };
}
const denied = (input) =>
  assert.throws(
    () => buildLoopbackRelayPlan(input),
    (e) => e instanceof RelayPlanError && e.code === 'relay_unqualified',
  );
test('renders private bounded relay only from pinned inspected container and internal network', () => {
  const f = fixture(),
    p = buildLoopbackRelayPlan(f);
  assert.equal(p.automaticExecution, false);
  assert.deepEqual(p.listen, { host: '127.0.0.1', port: 3101 });
  assert.deepEqual(p.target, {
    containerId: id,
    imageId: image,
    networkId: network,
    address: '172.30.0.2',
    port: 3101,
  });
  assert.equal(p.systemdProperties.MemoryMax, '64M');
  assert.equal(p.systemdProperties.CPUQuota, '10%');
  assert.equal(p.systemdProperties.MemorySwapMax, '0');
  assert.equal(p.systemdProperties.TasksMax, '32');
  assert.equal(p.requiresHealthCheckBeforeUse, true);
  assert.ok(p.pythonSource.includes("'/containers/' + CONTAINER_ID + '/json'"));
  assert.ok(p.pythonSource.includes("request('GET'"));
  assert.ok(!JSON.stringify(p).includes('never-copy-this-secret'));
  assert.ok(!p.pythonSource.includes('subprocess'));
  assert.ok(!p.pythonSource.includes('os.environ'));
  p.target.address = '127.0.0.1';
  assert.equal(
    f.containerInspect.NetworkSettings.Networks.pilot.IPAddress,
    '172.30.0.2',
  );
});
test('rejects wrong image/container, public or mixed networks, stale address and port/origin mismatch', () => {
  const mutations = [
    (f) => (f.expectedImageId = 'paperclip:latest'),
    (f) => (f.expectedContainerId = 'd'.repeat(64)),
    (f) => (f.containerInspect.Image = 'sha256:' + 'd'.repeat(64)),
    (f) => (f.containerInspect.State.Running = false),
    (f) => (f.networkInspect.Internal = false),
    (f) => (f.networkInspect.Driver = 'host'),
    (f) =>
      (f.containerInspect.NetworkSettings.Networks.extra = {
        NetworkID: 'd'.repeat(64),
        IPAddress: '172.31.0.2',
      }),
    (f) =>
      (f.containerInspect.NetworkSettings.Networks.pilot.IPAddress = '8.8.8.8'),
    (f) => (f.networkInspect.Containers[id].IPv4Address = '172.30.0.3/16'),
    (f) => (f.networkInspect.IPAM.Config[0].Subnet = '172.31.0.0/16'),
    (f) => (f.listenPort = 80),
    (f) => (f.containerInspect.Config.Env[1] = 'PORT=3100'),
    (f) =>
      (f.containerInspect.Config.Env[2] =
        'PAPERCLIP_PUBLIC_URL=http://evil.test:3101'),
    (f) => f.containerInspect.Config.Env.push('PORT=3101'),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    denied(f);
  }
});
test('rejects public port publishing, privileged mounts or relaxed runtime bounds', () => {
  for (const mutate of [
    (f) => (f.containerInspect.HostConfig.Privileged = true),
    (f) => (f.containerInspect.HostConfig.PublishAllPorts = true),
    (f) =>
      (f.containerInspect.HostConfig.PortBindings = {
        '3101/tcp': [{ HostIp: '127.0.0.1', HostPort: '3101' }],
      }),
    (f) => (f.containerInspect.NetworkSettings.Ports['3101/tcp'] = []),
    (f) =>
      f.containerInspect.Mounts.push({
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/var/run/docker.sock',
      }),
    (f) => (f.containerInspect.Mounts[0].Destination = '/root'),
    (f) => (f.containerInspect.HostConfig.MemorySwap = -1),
    (f) => (f.containerInspect.HostConfig.SecurityOpt = []),
  ]) {
    const f = fixture();
    mutate(f);
    denied(f);
  }
});

test('bind source and namespace/CPU isolation are independently pinned rather than inferred from inspect', () => {
  for (const mutate of [
    (f) => (f.containerInspect.Mounts[0].Source = '/'),
    (f) => (f.containerInspect.Mounts[0].Source = '/var/run/docker.sock'),
    (f) => (f.containerInspect.HostConfig.NanoCpus = 0),
    (f) => (f.containerInspect.HostConfig.NanoCpus = 2000000000),
    (f) => (f.containerInspect.HostConfig.PidMode = 'host'),
    (f) => (f.containerInspect.HostConfig.IpcMode = 'host'),
    (f) => (f.containerInspect.HostConfig.UsernsMode = 'host'),
    (f) => (f.containerInspect.HostConfig.CapAdd = ['SYS_ADMIN']),
    (f) =>
      (f.containerInspect.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]),
    (f) => (f.containerInspect.HostConfig.DeviceRequests = [{ Count: -1 }]),
    (f) => (f.containerInspect.HostConfig.VolumesFrom = ['foreign']),
    (f) => f.containerInspect.HostConfig.SecurityOpt.push('seccomp=unconfined'),
  ]) {
    const f = fixture();
    mutate(f);
    denied(f);
  }
  const f = fixture();
  f.expectedDataDirectory = '/opt/uain-test/paperclip-fixture/data';
  f.containerInspect.Mounts[0].Source = f.expectedDataDirectory;
  assert.equal(
    buildLoopbackRelayPlan(f).dataDirectory,
    f.expectedDataDirectory,
  );
  f.expectedDataDirectory = '/';
  denied(f);
});

test('generated handler rechecks identity after connect before forwarding any credential bytes', async () => {
  const { execFileSync } = await import('node:child_process');
  const source = buildLoopbackRelayPlan(fixture()).pythonSource;
  const regression = `
import json
ns={}
exec(${JSON.stringify(source)}.split("Server(('127.0.0.1', PORT)")[0],ns)
counts={'checks':0,'forwarded':0,'closed':False}
def target():
 counts['checks']+=1
 return counts['checks']==1
class FakeSocket:
 def settimeout(self,x):pass
 def recv(self,x):return b'Authorization: Bearer synthetic-test-only'
 def sendall(self,x):counts['forwarded']+=1
 def close(self):counts['closed']=True
client=FakeSocket();upstream=FakeSocket()
ns['current_target']=target
ns['socket'].create_connection=lambda *a,**k:upstream
class FakeSelector:
 def __init__(self):self.once=False
 def register(self,*a):pass
 def select(self,*a):
  if self.once:return []
  self.once=True
  return [(type('Key',(),{'fileobj':client,'data':upstream})(),0)]
 def close(self):pass
ns['selectors'].DefaultSelector=FakeSelector
handler=ns['Handler'].__new__(ns['Handler']);handler.request=client;handler.handle()
print(json.dumps(counts))
`;
  const result = JSON.parse(
    execFileSync('python3', ['-c', regression], {
      encoding: 'utf8',
      timeout: 3000,
    }),
  );
  assert.deepEqual(result, { checks: 2, forwarded: 0, closed: true });
});

test('production relay origin remains canonical3101 even when another port is internally self-consistent', () => {
  const f = fixture();
  f.listenPort = 3102;
  f.containerInspect.Config.Env[1] = 'PORT=3102';
  f.containerInspect.Config.Env[2] =
    'PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3102';
  denied(f);
});

test('stopped startup admission accepts only a pinned created/exited container on its exact private network', async () => {
  const relay = await import('./loopback-relay.mjs');
  assert.equal(typeof relay.validateStoppedRuntimeIsolation, 'function');
  const f = fixture(),
    name = 'baink-paperclip-pilot';
  f.expectedNetworkName = name;
  f.expectedNetworkId = network;
  f.networkInspect.Name = name;
  f.containerInspect.State = {
    Running: false,
    Status: 'created',
    Paused: false,
    Restarting: false,
    Dead: false,
  };
  f.containerInspect.HostConfig.NetworkMode = name;
  f.containerInspect.NetworkSettings.Networks = {
    [name]: { NetworkID: '', IPAddress: '' },
  };
  f.networkInspect.Containers = {};
  assert.equal(relay.validateStoppedRuntimeIsolation(f), true);
  f.containerInspect.State.Status = 'exited';
  f.containerInspect.NetworkSettings.Networks[name].NetworkID = network;
  assert.equal(relay.validateStoppedRuntimeIsolation(f), true);
  // The running relay policy still needs a real running endpoint and must not
  // acquire this stopped-container exception.
  denied(f);
});

test('stopped startup admission rejects changed resource caps, mounts, ports and network/identity substitutions', async () => {
  const relay = await import('./loopback-relay.mjs');
  assert.equal(typeof relay.validateStoppedRuntimeIsolation, 'function');
  const stopped = () => {
    const f = fixture(),
      name = 'baink-paperclip-pilot';
    f.expectedNetworkName = name;
    f.expectedNetworkId = network;
    f.networkInspect.Name = name;
    f.containerInspect.State = {
      Running: false,
      Status: 'exited',
      Paused: false,
      Restarting: false,
      Dead: false,
    };
    f.containerInspect.HostConfig.NetworkMode = name;
    f.containerInspect.NetworkSettings.Networks = {
      [name]: { NetworkID: '', IPAddress: '' },
    };
    f.networkInspect.Containers = {};
    return f;
  };
  for (const mutate of [
    (f) => (f.containerInspect.Id = 'd'.repeat(64)),
    (f) => (f.containerInspect.Image = 'sha256:' + 'd'.repeat(64)),
    (f) => (f.containerInspect.State.Running = true),
    (f) => (f.containerInspect.State.Status = 'running'),
    (f) => (f.containerInspect.State.Paused = true),
    (f) => (f.containerInspect.State.Restarting = true),
    (f) => (f.containerInspect.State.Dead = true),
    (f) => (f.containerInspect.HostConfig.Memory = 0),
    (f) => (f.containerInspect.HostConfig.MemorySwap = -1),
    (f) => (f.containerInspect.HostConfig.NanoCpus = 0),
    (f) => (f.containerInspect.HostConfig.PidsLimit = -1),
    (f) => (f.containerInspect.HostConfig.SecurityOpt = []),
    (f) => (f.containerInspect.HostConfig.CapAdd = ['SYS_ADMIN']),
    (f) => (f.containerInspect.HostConfig.PidMode = 'host'),
    (f) => (f.containerInspect.HostConfig.IpcMode = 'host'),
    (f) => (f.containerInspect.HostConfig.UsernsMode = 'host'),
    (f) =>
      (f.containerInspect.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]),
    (f) => (f.containerInspect.HostConfig.DeviceRequests = [{ Count: -1 }]),
    (f) => (f.containerInspect.HostConfig.VolumesFrom = ['foreign']),
    (f) => (f.containerInspect.HostConfig.PublishAllPorts = true),
    (f) =>
      (f.containerInspect.HostConfig.PortBindings = {
        '3101/tcp': [{ HostPort: '3101' }],
      }),
    (f) => (f.containerInspect.NetworkSettings.Ports['3101/tcp'] = []),
    (f) => (f.containerInspect.Mounts[0].Source = '/'),
    (f) =>
      f.containerInspect.Mounts.push({
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/var/run/docker.sock',
      }),
    (f) => (f.containerInspect.Config.Env[1] = 'PORT=3102'),
    (f) =>
      (f.containerInspect.Config.Env[2] =
        'PAPERCLIP_PUBLIC_URL=http://evil.test'),
    (f) => (f.containerInspect.HostConfig.NetworkMode = 'host'),
    (f) =>
      (f.containerInspect.NetworkSettings.Networks.extra = {
        NetworkID: 'd'.repeat(64),
        IPAddress: '',
      }),
    (f) =>
      (f.containerInspect.NetworkSettings.Networks[
        'baink-paperclip-pilot'
      ].NetworkID = 'd'.repeat(64)),
    (f) =>
      (f.containerInspect.NetworkSettings.Networks[
        'baink-paperclip-pilot'
      ].IPAddress = '8.8.8.8'),
    (f) => (f.networkInspect.Id = 'd'.repeat(64)),
    (f) => (f.networkInspect.Internal = false),
    (f) => (f.networkInspect.Driver = 'host'),
    (f) =>
      delete f.containerInspect.NetworkSettings.Networks[
        'baink-paperclip-pilot'
      ],
  ]) {
    const f = stopped();
    mutate(f);
    assert.throws(
      () => relay.validateStoppedRuntimeIsolation(f),
      (e) => e instanceof RelayPlanError && e.code === 'relay_unqualified',
    );
  }
});
