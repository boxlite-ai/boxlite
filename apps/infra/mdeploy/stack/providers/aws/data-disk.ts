import { RUNNER_HOME } from '../../runner-boot.ts'

export const AWS_DATA_DEVICE = '/dev/disk/by-id/boxlite-data'

/** Ubuntu/Nitro identifies EBS by NVMe serial, independent of kernel enumeration order. */
export const awsDataDiskSetup = ({
  volumeId,
  home = RUNNER_HOME,
  sysBlock = '/sys/block',
  devices = '/dev',
  link = AWS_DATA_DEVICE,
  fstab = '/etc/fstab',
}: {
  volumeId: string
  home?: string
  sysBlock?: string
  devices?: string
  link?: string
  fstab?: string
}): string => {
  if (
    !/^vol-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(volumeId) ||
    ![home, sysBlock, devices, link, fstab].every(
      (path) => /^\/[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').includes('..'),
    )
  ) {
    throw new Error('AWS data disk setup requires a volume ID and safe absolute paths')
  }
  return `expected_serial='${volumeId.replace('-', '')}'
data_device=''
for attempt in {1..120}; do
  for candidate in '${sysBlock}'/nvme*n1; do
    [ -f "$candidate/device/serial" ] || continue
    serial=$(tr -d '[:space:]' < "$candidate/device/serial")
    if [ "$serial" = "$expected_serial" ]; then data_device='${devices}/'"$(basename "$candidate")"; break; fi
  done
  [ -n "$data_device" ] && break
  sleep 5
done
[ -n "$data_device" ] || { echo 'FATAL: the assigned EBS data disk did not attach' >&2; exit 1; }
blockdev --getsize64 "$data_device" >/dev/null
mountpoints=$(lsblk -nr -o MOUNTPOINT "$data_device")
if printf '%s\\n' "$mountpoints" | grep -qxF /; then
  echo 'FATAL: refusing to use the root disk as Runner data' >&2; exit 1
fi
[ ! -L '${home}' ] || { echo 'FATAL: Runner home must not be a symlink' >&2; exit 1; }
if [ -e '${link}' ] && [ ! -L '${link}' ]; then
  echo 'FATAL: data device link would replace another path' >&2; exit 1
fi
mkdir -p '${home}' "$(dirname '${link}')"
if mountpoint -q '${home}'; then
  source_device=$(findmnt -n -o SOURCE --target '${home}')
  resolved_source=$(readlink -f "$source_device")
  resolved_data=$(readlink -f "$data_device")
  [ -n "$resolved_source" ] && [ "$resolved_source" = "$resolved_data" ] || {
    echo 'FATAL: Runner home is mounted from another device' >&2; exit 1;
  }
else
  [ -z "$(find '${home}' -mindepth 1 -maxdepth 1 -print -quit)" ] || {
    echo 'FATAL: Runner home contains local state; copy and verify it before mounting EBS' >&2; exit 1;
  }
  filesystem=$(blkid -o value -s TYPE "$data_device" || true)
  if [ -z "$filesystem" ]; then
    signatures=$(wipefs --noheadings --output TYPE "$data_device")
    [ -z "$signatures" ] || { echo 'FATAL: refusing to format a disk with existing signatures' >&2; exit 1; }
    mkfs.ext4 -F "$data_device"
  else
    [ "$filesystem" = ext4 ] || { echo 'FATAL: assigned data disk is not ext4' >&2; exit 1; }
  fi
  uuid=$(blkid -o value -s UUID "$data_device")
  [[ "$uuid" =~ ^[A-Fa-f0-9-]+$ ]] || { echo 'FATAL: data disk has no filesystem UUID' >&2; exit 1; }
  awk -v home='${home}' -v source="UUID=$uuid" '$2 == home && $1 != source { exit 1 }' '${fstab}' || {
    echo 'FATAL: Runner home already has another filesystem in fstab' >&2; exit 1;
  }
  grep -qF "UUID=$uuid ${home} " '${fstab}' || printf 'UUID=%s ${home} ext4 defaults 0 2\\n' "$uuid" >> '${fstab}'
  mount "$data_device" '${home}'
fi
ln -sfn "$data_device" '${link}'
`
}

export const awsDataDiskEnvironment = ({
  accountId,
  zone,
  volumeId,
}: {
  accountId: string
  zone: string
  volumeId: string
}): Record<string, string> => ({
  RUNNER_DATA_DISK_PROVIDER: 'aws',
  RUNNER_DATA_DISK_PROJECT: accountId,
  RUNNER_DATA_DISK_ZONE: zone,
  RUNNER_DATA_DISK_NAME: volumeId,
  RUNNER_DATA_DISK_TYPE: 'gp3',
  RUNNER_DATA_DISK_DEVICE: `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace('-', '')}`,
})
