/**
 * BoxLite C SDK - Image Handle Integration Tests
 */

#include "test_runtime.h"
#include <string.h>

static void test_runtime_images_pull_and_list(void) {
  printf("\nTEST: Runtime image handle pull/list\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-images";
  reset_test_home(temp_dir);

  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  CBoxliteImageHandle *images = NULL;
  BoxliteErrorCode code = boxlite_runtime_images(runtime, &images, &error);
  assert(code == Ok);
  assert(images != NULL);

  char *pull_json = NULL;
  code = boxlite_image_pull(images, "alpine:latest", &pull_json, &error);
  assert(code == Ok);
  assert(pull_json != NULL);
  assert(strstr(pull_json, "\"reference\":\"alpine:latest\"") != NULL);
  assert(strstr(pull_json, "\"config_digest\":\"sha256:") != NULL);
  assert(strstr(pull_json, "\"layer_count\":") != NULL);
  printf("  ✓ Pulled image: %s\n", pull_json);
  boxlite_free_string(pull_json);

  char *list_json = NULL;
  code = boxlite_image_list(images, &list_json, &error);
  assert(code == Ok);
  assert(list_json != NULL);
  assert(strstr(list_json, "alpine") != NULL);
  assert(strstr(list_json, "\"cached_at\":\"") != NULL);
  printf("  ✓ Listed images: %s\n", list_json);
  boxlite_free_string(list_json);

  boxlite_image_free(images);
  boxlite_runtime_free(runtime);
}

static void test_runtime_images_rejected_after_shutdown(void) {
  printf("\nTEST: Runtime image handle rejects shutdown runtime\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-images-shutdown";
  reset_test_home(temp_dir);

  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  BoxliteErrorCode code = boxlite_runtime_shutdown(runtime, 0, &error);
  assert(code == Ok);

  CBoxliteImageHandle *images = NULL;
  code = boxlite_runtime_images(runtime, &images, &error);
  assert(code == Stopped);
  assert(images == NULL);
  assert(error.message != NULL);
  assert(strstr(error.message, "shut down") != NULL ||
         strstr(error.message, "closed") != NULL);

  boxlite_error_free(&error);
  boxlite_runtime_free(runtime);
}

static void test_image_pull_rejected_after_runtime_free(void) {
  printf("\nTEST: Image handle rejects runtime free\n");

  CBoxliteError error = {0};
  const char *temp_dir = "/tmp/boxlite-test-images-free";
  reset_test_home(temp_dir);

  CBoxliteRuntime *runtime = new_test_runtime(temp_dir, &error);
  CBoxliteImageHandle *images = NULL;
  BoxliteErrorCode code = boxlite_runtime_images(runtime, &images, &error);
  assert(code == Ok);
  assert(images != NULL);

  boxlite_runtime_free(runtime);

  char *pull_json = NULL;
  code = boxlite_image_pull(images, "alpine:latest", &pull_json, &error);
  assert(code == Stopped);
  assert(pull_json == NULL);
  assert(error.message != NULL);
  assert(strstr(error.message, "shut down") != NULL ||
         strstr(error.message, "closed") != NULL);

  boxlite_error_free(&error);
  boxlite_image_free(images);
}

int main(void) {
  printf("BoxLite C SDK - Image Handle Tests\n");
  printf("==================================\n");

  test_runtime_images_pull_and_list();
  test_runtime_images_rejected_after_shutdown();
  test_image_pull_rejected_after_runtime_free();

  printf("\n✅ All image handle tests passed!\n");
  return 0;
}
