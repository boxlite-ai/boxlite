module github.com/containers/gvisor-tap-vsock

go 1.23.0

require (
	github.com/Microsoft/go-winio v0.6.2
	github.com/apparentlymart/go-cidr v1.1.0
	github.com/boxlite-ai/tcprelay v0.0.0
	github.com/containers/winquit v1.1.0
	github.com/coreos/stream-metadata-go v0.4.9
	github.com/dustin/go-humanize v1.0.1
	github.com/google/gopacket v1.1.19
	github.com/insomniacslk/dhcp v0.0.0-20240710054256-ddd8a41251c9
	github.com/linuxkit/virtsock v0.0.0-20220523201153-1a23e78aa7a2
	github.com/mdlayher/vsock v1.2.1
	github.com/miekg/dns v1.1.68
	github.com/onsi/ginkgo v1.16.5
	github.com/onsi/gomega v1.38.0
	github.com/opencontainers/go-digest v1.0.0
	github.com/pkg/errors v0.9.1
	github.com/sirupsen/logrus v1.9.3
	github.com/songgao/packets v0.0.0-20160404182456-549a10cd4091
	github.com/songgao/water v0.0.0-20200317203138-2b4b6d7c09d8
	github.com/stretchr/testify v1.10.0
	github.com/vishvananda/netlink v1.3.1
	golang.org/x/crypto v0.41.0
	golang.org/x/mod v0.27.0
	golang.org/x/sync v0.16.0
	golang.org/x/sys v0.35.0
	gvisor.dev/gvisor v0.0.0-20240916094835-a174eb65023f
)

require (
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/fsnotify/fsnotify v1.8.0 // indirect
	github.com/google/btree v1.1.2 // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/mdlayher/socket v0.4.1 // indirect
	github.com/nxadm/tail v1.4.8 // indirect
	github.com/pierrec/lz4/v4 v4.1.14 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	github.com/u-root/uio v0.0.0-20240224005618-d2acac8f3701 // indirect
	github.com/vishvananda/netns v0.0.5 // indirect
	golang.org/x/net v0.42.0 // indirect
	golang.org/x/text v0.28.0 // indirect
	golang.org/x/time v0.5.0 // indirect
	golang.org/x/tools v0.35.0 // indirect
	gopkg.in/tomb.v1 v1.0.0-20141024135613-dd632973f1e7 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/boxlite-ai/tcprelay => ../../../../../apps/libs/tcprelay
