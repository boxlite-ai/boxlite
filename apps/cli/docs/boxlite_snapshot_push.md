## boxlite snapshot push

Push local snapshot

### Synopsis

Push a local Docker image to BoxLite. To securely build it on our infrastructure, use 'boxlite snapshot build'

```
boxlite snapshot push [SNAPSHOT] [flags]
```

### Options

```
      --cpu int32           CPU cores that will be allocated to the underlying sandboxes (default: 1)
      --disk int32          Disk space that will be allocated to the underlying sandboxes in GB (default: 3)
  -e, --entrypoint string   The entrypoint command for the image
      --memory int32        Memory that will be allocated to the underlying sandboxes in GB (default: 1)
  -n, --name string         Specify the Snapshot name
      --region string       ID of the region where the snapshot will be available (defaults to organization default region)
```

### Options inherited from parent commands

```
      --help   help for boxlite
```

### SEE ALSO

* [boxlite snapshot](boxlite_snapshot.md)  - Manage BoxLite snapshots
