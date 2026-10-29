package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
)

type Client struct {
	client *http.Client
	base   string
}

func New(client *http.Client, base string) *Client {
	return &Client{
		client: client,
		base:   base,
	}
}

func (c *Client) List() ([]types.ExposeRequest, error) {
	res, err := c.client.Get(fmt.Sprintf("%s%s", c.base, "/services/forwarder/all"))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", res.StatusCode)
	}
	dec := json.NewDecoder(res.Body)
	var ports []types.ExposeRequest
	if err := dec.Decode(&ports); err != nil {
		return nil, err
	}
	return ports, nil
}

func (c *Client) Expose(req *types.ExposeRequest) error {
	bin, err := json.Marshal(req)
	if err != nil {
		return err
	}
	res, err := c.client.Post(fmt.Sprintf("%s%s", c.base, "/services/forwarder/expose"), "application/json", bytes.NewReader(bin))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		err, readErr := io.ReadAll(res.Body)
		if readErr != nil {
			return fmt.Errorf("error while reading error message: %v", readErr)
		}
		return errors.New(strings.TrimSpace(string(err)))
	}
	return nil
}

func (c *Client) Unexpose(req *types.UnexposeRequest) error {
	bin, err := json.Marshal(req)
	if err != nil {
		return err
	}
	res, err := c.client.Post(fmt.Sprintf("%s%s", c.base, "/services/forwarder/unexpose"), "application/json", bytes.NewReader(bin))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		err, readErr := io.ReadAll(res.Body)
		if readErr != nil {
			return fmt.Errorf("error while reading error message: %v", readErr)
		}
		return errors.New(strings.TrimSpace(string(err)))
	}
	return nil
}

func (c *Client) ListDNS() ([]types.Zone, error) {
	res, err := c.client.Get(fmt.Sprintf("%s%s", c.base, "/services/dns/all"))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", res.StatusCode)
	}
	dec := json.NewDecoder(res.Body)
	var dnsZone []types.Zone
	if err := dec.Decode(&dnsZone); err != nil {
		return nil, err
	}
	return dnsZone, nil
}

func (c *Client) AddDNS(req *types.Zone) error {
	bin, err := json.Marshal(req)
	if err != nil {
		return err
	}
	res, err := c.client.Post(fmt.Sprintf("%s%s", c.base, "/services/dns/add"), "application/json", bytes.NewReader(bin))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		err, readErr := io.ReadAll(res.Body)
		if readErr != nil {
			return fmt.Errorf("error while reading error message: %v", readErr)
		}
		return errors.New(strings.TrimSpace(string(err)))
	}
	return nil
}
