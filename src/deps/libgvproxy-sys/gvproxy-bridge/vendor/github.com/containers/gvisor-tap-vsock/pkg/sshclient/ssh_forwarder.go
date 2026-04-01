package sshclient

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/fs"
	"github.com/containers/gvisor-tap-vsock/pkg/utils"
	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"
)

type CloseWriteStream interface {
	io.Reader
	io.WriteCloser
	CloseWrite() error
}

type CloseWriteConn interface {
	net.Conn
	CloseWriteStream
}

type SSHForward struct {
	listener net.Listener
	bastion  *Bastion
	sock     *url.URL
}

type SSHDialer interface {
	DialContextTCP(ctx context.Context, addr string) (net.Conn, error)
}

type genericTCPDialer struct {
}

var defaultTCPDialer genericTCPDialer

func (dialer *genericTCPDialer) DialContextTCP(ctx context.Context, addr string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", addr)
}

func CreateSSHForward(ctx context.Context, src *url.URL, dest *url.URL, identity string, dialer SSHDialer) (*SSHForward, error) {
	if dialer == nil {
		dialer = &defaultTCPDialer
	}

	return setupProxy(ctx, src, dest, identity, "", dialer)
}

func CreateSSHForwardPassphrase(ctx context.Context, src *url.URL, dest *url.URL, identity string, passphrase string, dialer SSHDialer) (*SSHForward, error) {
	if dialer == nil {
		dialer = &defaultTCPDialer
	}

	return setupProxy(ctx, src, dest, identity, passphrase, dialer)
}

func (forward *SSHForward) AcceptAndTunnel(ctx context.Context) error {
	return acceptConnection(ctx, forward.listener, forward.bastion, forward.sock)
}

func (forward *SSHForward) Tunnel(ctx context.Context) (CloseWriteConn, error) {
	return connectForward(ctx, forward.bastion)
}

func (forward *SSHForward) Close() {
	if forward.listener != nil {
		forward.listener.Close()
	}
	if forward.bastion != nil {
		forward.bastion.Close()
	}
}

func connectForward(ctx context.Context, bastion *Bastion) (CloseWriteConn, error) {
	for retries := 1; ; retries++ {
		forward, err := bastion.Client.Dial("unix", bastion.Path)
		if err == nil {
			return forward.(CloseWriteConn), nil
		}
		if retries > 2 {
			return nil, errors.Wrapf(err, "Couldn't reestablish ssh tunnel on path: %s", bastion.Path)
		}
		// Check if ssh connection is still alive
		_, _, err = bastion.Client.SendRequest("alive@gvproxy", true, nil)
		if err != nil {
			for bastionRetries := 1; ; bastionRetries++ {
				err = bastion.Reconnect(ctx)
				if err == nil {
					break
				}
				if bastionRetries > 2 || !utils.Sleep(ctx, 200*time.Millisecond) {
					return nil, errors.Wrapf(err, "Couldn't reestablish ssh connection: %s", bastion.Host)
				}
			}
		}

		if !utils.Sleep(ctx, 200*time.Millisecond) {
			retries = 3
		}
	}
}

func listenUnix(socketURI *url.URL) (net.Listener, error) {
	path := socketURI.Path
	if runtime.GOOS == "windows" {
		path = strings.TrimPrefix(path, "/")
	}

	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, err
	}

	oldmask := fs.Umask(0177)
	defer fs.Umask(oldmask)
	listener, err := net.Listen("unix", path)
	if err != nil {
		return listener, errors.Wrapf(err, "Error listening on socket: %s", socketURI.Path)
	}

	return listener, nil
}

func setupProxy(ctx context.Context, socketURI *url.URL, dest *url.URL, identity string, passphrase string, dialer SSHDialer) (*SSHForward, error) {
	var (
		listener net.Listener
		err      error
	)
	switch socketURI.Scheme {
	case "unix":
		listener, err = listenUnix(socketURI)
		if err != nil {
			return &SSHForward{}, err
		}
	case "npipe":
		listener, err = ListenNpipe(socketURI)
		if err != nil {
			return &SSHForward{}, err
		}
	case "":
		// empty URL = Tunnel Only, no Accept
	default:
		return &SSHForward{}, errors.Errorf("URI scheme not supported: %s", socketURI.Scheme)
	}

	connectFunc := func(ctx context.Context, bastion *Bastion) (net.Conn, error) {
		timeout := 5 * time.Second
		if bastion != nil {
			timeout = bastion.Config.Timeout
		}
		ctx, cancel := context.WithTimeout(ctx, timeout)
		conn, err := dialer.DialContextTCP(ctx, dest.Host)
		if cancel != nil {
			cancel()
		}

		return conn, err
	}

	createBastion := func() (*Bastion, error) {
		conn, err := connectFunc(ctx, nil)
		if err != nil {
			return nil, err
		}
		return CreateBastion(dest, passphrase, identity, conn, connectFunc)
	}
	bastion, err := utils.Retry(ctx, createBastion, "Waiting for sshd")
	if err != nil {
		return &SSHForward{}, fmt.Errorf("setupProxy failed: %w", err)
	}

	logrus.Debugf("Socket forward established: %s -> %s\n", socketURI.Path, dest.Path)

	return &SSHForward{listener, bastion, socketURI}, nil
}

func acceptConnection(ctx context.Context, listener net.Listener, bastion *Bastion, socketURI *url.URL) error {
	con, err := listener.Accept()
	if err != nil {
		return errors.Wrapf(err, "Error accepting on socket: %s", socketURI.Path)
	}

	src, ok := con.(CloseWriteStream)
	if !ok {
		con.Close()
		return errors.Wrapf(err, "Underlying socket does not support half-close %s", socketURI.Path)
	}

	var dest CloseWriteStream

	dest, err = connectForward(ctx, bastion)
	if err != nil {
		con.Close()
		logrus.Error(err)
		return nil // eat
	}

	complete := new(sync.WaitGroup)
	complete.Add(2)
	go forward(src, dest, complete)
	go forward(dest, src, complete)

	go func() {
		complete.Wait()
		src.Close()
		dest.Close()
	}()

	return nil
}

func forward(src io.ReadCloser, dest CloseWriteStream, complete *sync.WaitGroup) {
	defer complete.Done()
	_, _ = io.Copy(dest, src)

	// Trigger an EOF on the other end
	_ = dest.CloseWrite()
}
