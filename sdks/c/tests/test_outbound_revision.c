#include "boxlite.h"
#include <assert.h>
#include <stdint.h>

int main(void) {
  CBoxliteError error = {0};
  char sentinel = 'x';
  char *json = &sentinel;
  assert(boxlite_network_outbound_snapshot(NULL, &json, &error) ==
         InvalidArgument);
  assert(json == NULL);
  boxlite_error_free(&error);

  json = &sentinel;
  assert(boxlite_network_outbound_status(NULL, &json, &error) ==
         InvalidArgument);
  assert(json == NULL);
  boxlite_error_free(&error);

  uint8_t applied = 99;
  assert(boxlite_network_replace_outbound_snapshot(
             NULL, "rev-a", "rev-b", "{\"mode\":\"enabled\"}", &applied,
             &error) == InvalidArgument);
  assert(applied == 0);
  boxlite_error_free(&error);

  assert(boxlite_network_outbound_status(NULL, NULL, NULL) == InvalidArgument);
  assert(boxlite_network_replace_outbound_snapshot(
             NULL, "rev-a", "rev-b", "{}", NULL, NULL) == InvalidArgument);
  boxlite_free_string(NULL);
  return 0;
}
