import { isIPv4 } from 'node:net';

export class RelayPlanError extends Error {
  constructor() {
    super('Private relay could not be qualified.');
    this.code = 'relay_unqualified';
  }
}
const requireFact = (ok) => {
  if (!ok) throw new RelayPlanError();
};
const hex = /^[a-f0-9]{64}$/;
const integerIp = (ip) =>
  ip.split('.').reduce((n, v) => n * 256 + Number(v), 0);
function privateIp(ip) {
  return (
    typeof ip === 'string' &&
    isIPv4(ip) &&
    (ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      (ip.startsWith('172.') &&
        Number(ip.split('.')[1]) >= 16 &&
        Number(ip.split('.')[1]) <= 31))
  );
}
function inSubnet(ip, subnet) {
  if (typeof subnet !== 'string') return false;
  const [base, bits, extra] = subnet.split('/');
  if (
    extra !== undefined ||
    !privateIp(base) ||
    !/^(?:[89]|[12][0-9]|30)$/.test(bits ?? '')
  )
    return false;
  const block = 2 ** (32 - Number(bits));
  return (
    Math.floor(integerIp(base) / block) === Math.floor(integerIp(ip) / block)
  );
}

function requireRuntimeIsolation({
  expectedContainerId,
  expectedImageId,
  containerInspect: c,
  listenPort = 3101,
  expectedDataDirectory = '/var/lib/baink-paperclip/data',
} = {}) {
  requireFact(
    typeof expectedDataDirectory === 'string' &&
      /^\/(?:[a-zA-Z0-9_-]+\/){2,}[a-zA-Z0-9_-]+$/.test(expectedDataDirectory),
  );
  requireFact(
    hex.test(expectedContainerId ?? '') &&
      /^sha256:[a-f0-9]{64}$/.test(expectedImageId ?? ''),
  );
  requireFact(listenPort === 3101);
  requireFact(c?.Id === expectedContainerId && c.Image === expectedImageId);
  const h = c.HostConfig;
  requireFact(
    h &&
      h.Privileged === false &&
      h.PublishAllPorts === false &&
      Object.keys(h.PortBindings ?? {}).length === 0,
  );
  requireFact(
    h.Memory === 2147483648 &&
      h.MemorySwap === h.Memory &&
      h.PidsLimit > 0 &&
      h.PidsLimit <= 256 &&
      h.NanoCpus === 1000000000 &&
      h.PidMode === '' &&
      h.IpcMode === 'private' &&
      h.UsernsMode === '' &&
      [
        'CapAdd',
        'Devices',
        'DeviceRequests',
        'DeviceCgroupRules',
        'VolumesFrom',
      ].every(
        (key) =>
          h[key] === null || (Array.isArray(h[key]) && h[key].length === 0),
      ) &&
      Array.isArray(h.SecurityOpt) &&
      h.SecurityOpt.length === 1 &&
      h.SecurityOpt[0] === 'no-new-privileges:true',
  );
  requireFact(
    Array.isArray(c.Mounts) &&
      c.Mounts.length === 1 &&
      c.Mounts[0].Type === 'bind' &&
      c.Mounts[0].Destination === '/paperclip' &&
      c.Mounts[0].Source === expectedDataDirectory,
  );
  const env = c.Config?.Env;
  requireFact(Array.isArray(env));
  for (const [key, value] of Object.entries({
    HOST: '0.0.0.0',
    PORT: String(listenPort),
    PAPERCLIP_PUBLIC_URL: `http://127.0.0.1:${listenPort}`,
  })) {
    const found = env.filter(
      (v) => typeof v === 'string' && v.startsWith(key + '='),
    );
    requireFact(found.length === 1 && found[0] === key + '=' + value);
  }
  requireFact(
    Object.values(c.NetworkSettings?.Ports ?? {}).every(
      (value) => value === null,
    ),
  );
}

/** No Docker call, process launch or secret output. The operator supplies fresh
 * inspect results and independently qualified artifact/container pins. */
export function buildLoopbackRelayPlan({
  expectedContainerId,
  expectedImageId,
  containerInspect: c,
  networkInspect: n,
  listenPort = 3101,
  expectedDataDirectory = '/var/lib/baink-paperclip/data',
} = {}) {
  requireRuntimeIsolation({
    expectedContainerId,
    expectedImageId,
    containerInspect: c,
    listenPort,
    expectedDataDirectory,
  });
  requireFact(c.State?.Running === true);
  const networks = Object.values(c.NetworkSettings?.Networks ?? {});
  requireFact(
    networks.length === 1 &&
      n?.Internal === true &&
      n.Driver === 'bridge' &&
      hex.test(n.Id ?? ''),
  );
  const network = networks[0],
    ip = network.IPAddress;
  requireFact(network.NetworkID === n.Id && privateIp(ip));
  requireFact(
    n.Containers?.[expectedContainerId]?.IPv4Address?.split('/')[0] === ip,
  );
  requireFact(
    Array.isArray(n.IPAM?.Config) &&
      n.IPAM.Config.some((config) => inSubnet(ip, config.Subnet)),
  );
  const pins = {
    containerId: expectedContainerId,
    imageId: expectedImageId,
    networkId: n.Id,
    address: ip,
    port: listenPort,
  };
  return {
    automaticExecution: false,
    dataDirectory: expectedDataDirectory,
    requiresHealthCheckBeforeUse: true,
    listen: { host: '127.0.0.1', port: listenPort },
    target: pins,
    systemdProperties: {
      MemoryMax: '64M',
      MemorySwapMax: '0',
      CPUQuota: '10%',
      TasksMax: '32',
      NoNewPrivileges: 'true',
      PrivateTmp: 'true',
      PrivateDevices: 'true',
      ProtectSystem: 'strict',
      ProtectHome: 'true',
      CapabilityBoundingSet: '',
      TimeoutStopSec: '5',
    },
    // The only Docker operation is a fixed, bounded read of this pinned ID on
    // each accepted connection. A stopped/replaced/re-networked container fails
    // closed before forwarding any bytes; IP reuse cannot redirect credentials.
    pythonSource: renderPython(pins, expectedDataDirectory),
  };
}
/** Startup admission only: a created/exited container has no forwarding
 * endpoint yet. Its sole configured network must still be the separately pinned
 * internal bridge. Missing fields are not inferred as proven absence. */
export function validateStoppedRuntimeIsolation({
  expectedContainerId,
  expectedImageId,
  expectedNetworkId,
  expectedNetworkName,
  expectedDataDirectory = '/var/lib/baink-paperclip/data',
  containerInspect: c,
  networkInspect: n,
} = {}) {
  requireRuntimeIsolation({
    expectedContainerId,
    expectedImageId,
    expectedDataDirectory,
    containerInspect: c,
  });
  requireFact(
    c.State?.Running === false &&
      ['created', 'exited'].includes(c.State.Status) &&
      c.State.Paused !== true &&
      c.State.Restarting !== true &&
      c.State.Dead !== true,
  );
  requireFact(
    typeof expectedNetworkName === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(expectedNetworkName) &&
      hex.test(expectedNetworkId ?? ''),
  );
  requireFact(
    c.HostConfig.NetworkMode === expectedNetworkName &&
      n?.Id === expectedNetworkId &&
      n.Name === expectedNetworkName &&
      n.Internal === true &&
      n.Driver === 'bridge',
  );
  const networks = c.NetworkSettings?.Networks;
  requireFact(
    networks &&
      typeof networks === 'object' &&
      !Array.isArray(networks) &&
      Object.keys(networks).length === 1 &&
      Object.hasOwn(networks, expectedNetworkName),
  );
  const entry = networks[expectedNetworkName];
  requireFact(
    entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (entry.NetworkID === '' || entry.NetworkID === expectedNetworkId),
  );
  requireFact(
    entry.IPAddress === '' ||
      (privateIp(entry.IPAddress) &&
        Array.isArray(n.IPAM?.Config) &&
        n.IPAM.Config.some((config) =>
          inSubnet(entry.IPAddress, config.Subnet),
        ) &&
        n.Containers?.[expectedContainerId]?.IPv4Address?.split('/')[0] ===
          entry.IPAddress),
  );
  return true;
}

function renderPython(p, dataDirectory) {
  return `import socket, socketserver, selectors, threading, http.client, json
CONTAINER_ID = ${JSON.stringify(p.containerId)}
IMAGE_ID = ${JSON.stringify(p.imageId)}
NETWORK_ID = ${JSON.stringify(p.networkId)}
TARGET_IP = ${JSON.stringify(p.address)}
DATA_DIRECTORY = ${JSON.stringify(dataDirectory)}
PORT = ${p.port}
LIMIT = threading.BoundedSemaphore(16)
INSPECT_LOCK = threading.Lock()
class DockerRead(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(2)
        self.sock.connect('/var/run/docker.sock')
def current_target():
    # Never use names, list endpoints, shell commands, environment targets or
    # Docker writes. Do not log the inspect result (it contains server secrets).
    with INSPECT_LOCK:
        client = DockerRead('localhost', timeout=2)
        try:
            client.request('GET', '/containers/' + CONTAINER_ID + '/json', headers={'Connection':'close'})
            response = client.getresponse()
            raw = response.read(262145)
            if response.status != 200 or len(raw) > 262144:
                return False
            c = json.loads(raw)
            h = c.get('HostConfig', {})
            mounts = c.get('Mounts', [])
            isolated = h.get('Privileged') is False and h.get('NanoCpus') == 1000000000 and h.get('Memory') == 2147483648 and h.get('MemorySwap') == 2147483648 and 0 < h.get('PidsLimit', 0) <= 256 and h.get('PidMode') == '' and h.get('IpcMode') == 'private' and h.get('UsernsMode') == '' and h.get('SecurityOpt') == ['no-new-privileges:true'] and all(h.get(key) in [None, []] for key in ['CapAdd','Devices','DeviceRequests','DeviceCgroupRules','VolumesFrom']) and not h.get('PublishAllPorts') and not h.get('PortBindings')
            isolated = isolated and len(mounts) == 1 and mounts[0].get('Type') == 'bind' and mounts[0].get('Source') == DATA_DIRECTORY and mounts[0].get('Destination') == '/paperclip'
            networks = list(c.get('NetworkSettings', {}).get('Networks', {}).values())
            return isolated and c.get('Id') == CONTAINER_ID and c.get('Image') == IMAGE_ID and c.get('State', {}).get('Running') is True and len(networks) == 1 and networks[0].get('NetworkID') == NETWORK_ID and networks[0].get('IPAddress') == TARGET_IP
        finally:
            client.close()
class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = None
        selector = None
        try:
            if not current_target():
                return
            upstream = socket.create_connection((TARGET_IP, PORT), timeout=5)
            # Connecting can race container removal/IP reuse. Recheck ownership
            # before reading any client bytes; an established TCP stream cannot
            # subsequently be redirected to a new container at the same IP.
            if not current_target():
                return
            upstream.settimeout(30)
            self.request.settimeout(30)
            selector = selectors.DefaultSelector()
            selector.register(self.request, selectors.EVENT_READ, upstream)
            selector.register(upstream, selectors.EVENT_READ, self.request)
            while True:
                events = selector.select(30)
                if not events:
                    return
                for key, _ in events:
                    data = key.fileobj.recv(16384)
                    if not data:
                        return
                    key.data.sendall(data)
        except Exception:
            pass
        finally:
            if selector:
                selector.close()
            if upstream:
                upstream.close()
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 16
    def process_request(self, request, address):
        if not LIMIT.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            LIMIT.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            LIMIT.release()
    def handle_error(self, request, address):
        pass
Server(('127.0.0.1', PORT), Handler).serve_forever(poll_interval=0.5)
`;
}
