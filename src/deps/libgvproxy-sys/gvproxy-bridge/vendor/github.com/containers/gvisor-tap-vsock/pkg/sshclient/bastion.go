package sshclient

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

var (
	homedirOnce sync.Once
	homedir     string
)

// Modified version of podman ssh client library, until a shared module exists

type Bastion struct {
	Client  *ssh.Client
	Config  *ssh.ClientConfig
	Host    string
	Port    string
	Path    string
	connect ConnectCallback
}

type ConnectCallback func(ctx context.Context, bastion *Bastion) (net.Conn, error)

func PublicKey(path string, passphrase []byte) (ssh.Signer, error) {
	key, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	signer, err := ssh.ParsePrivateKey(key)
	if err != nil {
		if _, ok := err.(*ssh.PassphraseMissingError); !ok {
			return nil, err
		}
		return ssh.ParsePrivateKeyWithPassphrase(key, passphrase)
	}
	return signer, nil
}

func HostKey(host string) ssh.PublicKey {
	// parse OpenSSH known_hosts file
	// ssh or use ssh-keyscan to get initial key
	knownHosts := filepath.Join(getHome(), ".ssh", "known_hosts")
	fd, err := os.Open(knownHosts)
	if err != nil {
		logrus.Error(err)
		return nil
	}

	// support -H parameter for ssh-keyscan
	hashhost := knownhosts.HashHostname(host)

	scanner := bufio.NewScanner(fd)
	for scanner.Scan() {
		_, hosts, key, _, _, err := ssh.ParseKnownHosts(scanner.Bytes())
		if err != nil {
			logrus.Errorf("Failed to parse known_hosts: %s", scanner.Text())
			continue
		}

		for _, h := range hosts {
			if h == host || h == hashhost {
				return key
			}
		}
	}

	return nil
}

func CreateBastion(_url *url.URL, passPhrase string, identity string, initial net.Conn, connect ConnectCallback) (*Bastion, error) {
	var authMethods []ssh.AuthMethod

	if len(identity) > 0 {
		s, err := PublicKey(identity, []byte(passPhrase))
		if err != nil {
			return nil, errors.Wrapf(err, "failed to parse identity %q", identity)
		}
		authMethods = append(authMethods, ssh.PublicKeys(s))
	}

	if pw, found := _url.User.Password(); found {
		authMethods = append(authMethods, ssh.Password(pw))
	}

	if len(authMethods) == 0 {
		return nil, errors.New("No available auth methods")
	}

	port := _url.Port()
	if port == "" {
		port = "22"
	}

	secure, _ := strconv.ParseBool(_url.Query().Get("secure"))

	callback := ssh.InsecureIgnoreHostKey() // #nosec
	if secure {
		host := _url.Hostname()
		if port != "22" {
			host = fmt.Sprintf("[%s]:%s", host, port)
		}
		key := HostKey(host)
		if key != nil {
			callback = ssh.FixedHostKey(key)
		}
	}

	config := &ssh.ClientConfig{
		User:            _url.User.Username(),
		Auth:            authMethods,
		HostKeyCallback: callback,
		HostKeyAlgorithms: []string{
			ssh.KeyAlgoRSA,
			ssh.KeyAlgoECDSA256,
			ssh.KeyAlgoECDSA384,
			ssh.KeyAlgoECDSA521,
			ssh.KeyAlgoED25519,
		},
		Timeout: 5 * time.Second,
	}

	if connect == nil {
		connect = func(_ context.Context, bastion *Bastion) (net.Conn, error) {
			conn, err := net.DialTimeout("tcp",
				net.JoinHostPort(bastion.Host, bastion.Port),
				bastion.Config.Timeout,
			)

			return conn, err
		}
	}

	bastion := Bastion{nil, config, _url.Hostname(), port, _url.Path, connect}
	return &bastion, bastion.reconnect(context.Background(), initial)
}

func (bastion *Bastion) Reconnect(ctx context.Context) error {
	return bastion.reconnect(ctx, nil)
}

func (bastion *Bastion) Close() {
	if bastion.Client != nil {
		bastion.Client.Close()
	}
}

func (bastion *Bastion) reconnect(ctx context.Context, conn net.Conn) error {
	var err error
	if conn == nil {
		conn, err = bastion.connect(ctx, bastion)
	}
	if err != nil {
		return errors.Wrapf(err, "Connection to bastion host (%s) failed", bastion.Host)
	}
	addr := net.JoinHostPort(bastion.Host, bastion.Port)
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, bastion.Config)
	if err != nil {
		return err
	}
	bastion.Client = ssh.NewClient(c, chans, reqs)
	return nil
}

func getHome() string {
	homedirOnce.Do(func() {
		env, err := os.UserHomeDir()
		if env == "" || err != nil {
			usr, err := user.LookupId(fmt.Sprintf("%d", os.Getuid()))
			if err != nil {
				logrus.Error("Could not determine user home directory!")
				homedir = ""
				return
			}

			homedir = usr.HomeDir
			return
		}
		homedir = env
	})
	return homedir
}
