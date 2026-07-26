#include "boxlite.h"

#include <assert.h>

int main(void) {
  CBoxInfo box = {0};
  CNetworkInfo network = {0};
  CPublishedPortList ports = {0};
  CPublishedPort port = {0};

  box.network = &network;
  network.mode = BoxliteNetworkModeEnabled;
  network.published_ports = &ports;
  ports.items = &port;
  ports.count = 1;
  port.protocol = BoxlitePortProtocolTcp;

  assert(box.network == &network);
  assert(box.network->published_ports == &ports);
  assert(box.network->published_ports->items == &port);
  return 0;
}
