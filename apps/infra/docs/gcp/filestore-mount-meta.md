# Runbook: query Filestore mount metadata on a GCP VM

[Infrastructure index](../README.md)

Use this when a GCE VM has a Filestore share mounted and you need to answer,
quickly and in order: **what is mounted, how it got there, what it points at,
and which GCP instance you are on.** The commands are read-only.

## 1. Confirm what is mounted

```bash
mount | grep -i nfs        # source, mountpoint, type (nfs4), and all options
df -h | grep nfs           # capacity and usage of the share
```

`mount` is the ground truth for "what is mounted"; `df` adds the capacity line
(the Filestore share advertises its provisioned size — 1.0T for the standard
zonal 1 TiB tier).

## 2. Find how it got there (fstab? or another mechanism)

```bash
grep -i nfs /etc/fstab     # often empty on managed hosts — exit code 1 here
                           # means "no match", not "error"
```

If fstab is silent, the next place to look is **systemd mount units** — this is
the key jump of the whole runbook:

```bash
systemctl list-units --type=mount | grep mnt     # spot the unit name (e.g. mnt-filestore.mount)
ls /etc/systemd/system/                          # see the unit files present
```

`systemctl list-units` is what turns "fstab has nothing" into a concrete
answer in one step: the unit name tells you which files to read next.

## 3. Read the configuration for the details

```bash
cat /etc/systemd/system/mnt-filestore.mount       # What=/Where=/Type=/Options=, plus Requires= wiring
cat /etc/systemd/system/filestore-route.service   # ExecStart= pointing at the route script
cat /usr/local/sbin/filestore-route               # the VLAN subinterface logic itself
ip -br addr                                       # confirm filestore0@ens4 exists
```

Typical shape on our hosts: the `.mount` unit declares the NFS target and
`Requires=` a companion service that builds a dedicated VLAN subinterface
(`filestore0@ens4`) before the mount is attempted — the route service exists
so the mount has a path to the Filestore's network. Read all three files; the
`.mount` unit alone does not show the network preparation.

## 4. GCP instance metadata (from inside the VM)

GCE exposes a metadata server to every VM at **169.254.169.254**
(`metadata.google.internal` is its resolvable name). Inside the machine the
queries need **no credentials**: they are authenticated by the network
location itself, provided the instance's service account has the default
access scopes (the default access mode covers read-only metadata).

```bash
curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/name
curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/id
curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/machine-type
curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/project/project-id
```

Use these to correlate the VM you are on with the GCP console: instance name
and numeric id identify it in the console, machine-type tells you the shape,
project-id confirms which project you are operating on.

---

Read-only end to end: nothing here changes mount state or instance state; the
curl calls are authenticated by the metadata server by virtue of running
inside the VM.
