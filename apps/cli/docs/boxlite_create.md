## boxlite create

Create a new box

```
boxlite create [flags]
```

### Options

```
      --auto-delete int32           Auto-delete interval in minutes (negative value means disabled, 0 means delete immediately upon stopping) (default -1)
      --auto-stop int32             Auto-stop interval in minutes (0 means disabled) (default 15)
      --class string                Box class type (small, medium, large)
  -c, --context stringArray         Files or directories to include in the build context (can be specified multiple times)
      --cpu int32                   CPU cores allocated to the box
      --disk int32                  Disk space allocated to the box in GB
  -f, --dockerfile string           Path to Dockerfile for Box snapshot
  -e, --env stringArray             Environment variables (format: KEY=VALUE)
      --gpu int32                   GPU units allocated to the box
  -l, --label stringArray           Labels (format: KEY=VALUE)
      --memory int32                Memory allocated to the box in MB
      --name string                 Name of the box
      --network-allow-list string   Comma-separated list of allowed CIDR network addresses for the box
      --network-block-all           Whether to block all network access for the box
      --public                      Make box publicly accessible
      --snapshot string             Snapshot to use for the box
      --target string               Target region (eu, us)
      --user string                 User associated with the box
  -v, --volume stringArray          Volumes to mount (format: VOLUME_NAME:MOUNT_PATH)
```

### Options inherited from parent commands

```
      --help   help for boxlite
```

### SEE ALSO

* [boxlite](boxlite.md)	 - BoxLite CLI

