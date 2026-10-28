#include "boxlite.h"
#include <arpa/inet.h>
#include <assert.h>
#include <string.h>

int main(void) {
  struct sockaddr_storage target;
  CBoxliteError error = {0};
  char ip[INET6_ADDRSTRLEN];

  assert(boxlite_socket_address_parse("127.0.0.1:3000", &target, &error) == Ok);
  assert(target.ss_family == AF_INET);
  const struct sockaddr_in *v4 = (const struct sockaddr_in *)&target;
  assert(ntohs(v4->sin_port) == 3000);
  assert(inet_ntop(AF_INET, &v4->sin_addr, ip, sizeof(ip)) != NULL);
  assert(strcmp(ip, "127.0.0.1") == 0);

  assert(boxlite_socket_address_parse("[::1]:65535", &target, &error) == Ok);
  assert(target.ss_family == AF_INET6);
  const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)&target;
  assert(ntohs(v6->sin6_port) == 65535);
  assert(v6->sin6_flowinfo == 0 && v6->sin6_scope_id == 0);
  assert(inet_ntop(AF_INET6, &v6->sin6_addr, ip, sizeof(ip)) != NULL);
  assert(strcmp(ip, "::1") == 0);

  unsigned char before[sizeof(target)];
  for (size_t i = 0; i < sizeof(target); ++i) {
    before[i] = ((const unsigned char *)&target)[i];
  }
  const char *invalid[] = {NULL,
                           "",
                           "localhost:3000",
                           "3000",
                           "::1:3000",
                           "127.0.0.1:-1",
                           "127.0.0.1:65536",
                           "unix:/tmp/socket",
                           "\xff"};
  for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
    assert(boxlite_socket_address_parse(invalid[i], &target, &error) ==
           InvalidArgument);
    assert(memcmp(before, &target, sizeof(target)) == 0);
    boxlite_error_free(&error);
  }
  assert(boxlite_socket_address_parse("127.0.0.1:3000", NULL, &error) ==
         InvalidArgument);
  boxlite_error_free(&error);
  assert(boxlite_socket_address_parse("127.0.0.1:0", &target, NULL) == Ok);
  return 0;
}
