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

  CImagePullResult *pull = NULL;
  code = boxlite_image_pull(images, "alpine:latest", &pull, &error);
  assert(code == Ok);
  assert(pull != NULL);
  assert(strcmp(pull->reference, "alpine:latest") == 0);
  assert(strstr(pull->config_digest, "sha256:") != NULL);
  assert(pull->layer_count > 0);
  printf("  ✓ Pulled image: %s (%d layers)\n", pull->reference,
         pull->layer_count);
  boxlite_free_image_pull_result(pull);

  CImageInfoList *list = NULL;
  code = boxlite_image_list(images, &list, &error);
  assert(code == Ok);
  assert(list != NULL);
  assert(list->count > 0);
  assert(strstr(list->items[0].reference, "alpine") != NULL);
  assert(list->items[0].cached_at > 0);
  printf("  ✓ Listed %d images\n", list->count);
  boxlite_free_image_info_list(list);

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

  CImagePullResult *pull = NULL;
  code = boxlite_image_pull(images, "alpine:latest", &pull, &error);
  assert(code == Stopped);
  assert(pull == NULL);
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
