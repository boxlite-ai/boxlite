package virtualnetwork

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	log "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip/header"
)

func (n *VirtualNetwork) AcceptVpnKit(conn net.Conn) error {
	if err := vpnkitHandshake(conn, n.configuration); err != nil {
		log.Error(err)
	}
	_ = n.networkSwitch.Accept(context.Background(), conn, types.HyperKitProtocol)
	return nil
}

func vpnkitHandshake(conn net.Conn, configuration *types.Configuration) error {
	// https://github.com/moby/hyperkit/blob/2f061e447e1435cdf1b9eda364cea6414f2c606b/src/lib/pci_virtio_net_vpnkit.c#L91
	msgInit := make([]byte, 49)
	if _, err := io.ReadFull(conn, msgInit); err != nil {
		return err
	}
	if _, err := conn.Write(msgInit); err != nil {
		return err
	}

	// https://github.com/moby/hyperkit/blob/2f061e447e1435cdf1b9eda364cea6414f2c606b/src/lib/pci_virtio_net_vpnkit.c#L123
	msgCommand := make([]byte, 41)
	if _, err := io.ReadFull(conn, msgCommand); err != nil {
		return err
	}
	vpnkitUUID := string(msgCommand[1:37])
	log.Debugf("UUID sent by Hyperkit: %s", vpnkitUUID)

	// https://github.com/moby/hyperkit/blob/2f061e447e1435cdf1b9eda364cea6414f2c606b/src/lib/pci_virtio_net_vpnkit.c#L131
	resp := make([]byte, 258)
	resp[0] = 0x01

	if configuration.MTU < 0 || configuration.MTU > math.MaxUint16 {
		return fmt.Errorf("invalid MTU: %d", configuration.MTU)
	}
	mtu := uint16(configuration.MTU)
	binary.LittleEndian.PutUint16(resp[1:3], mtu)
	binary.LittleEndian.PutUint16(resp[3:5], mtu+header.EthernetMinimumSize)

	mac, err := macAddr(configuration, vpnkitUUID)
	if err != nil {
		return err
	}
	log.Debugf("Sending mac address: %s", mac.String())

	copy(resp[5:11], mac)

	_, err = conn.Write(resp)
	return err
}

func macAddr(configuration *types.Configuration, vpnkitUUID string) (net.HardwareAddr, error) {
	macStr, ok := configuration.VpnKitUUIDMacAddresses[vpnkitUUID]
	if !ok {
		return randomMac()
	}
	return net.ParseMAC(macStr)
}

func randomMac() (net.HardwareAddr, error) {
	buf := make([]byte, 6)
	_, err := rand.Read(buf)
	if err != nil {
		return nil, err
	}

	// Set the local bit
	buf[0] |= 2

	// Set the single address bit
	buf[0] &= ^byte(1)

	return buf, nil
}
