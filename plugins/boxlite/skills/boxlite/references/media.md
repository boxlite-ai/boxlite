# When the app needs persistent uploads

Create and attach a managed volume when required:

~~~sh
boxlite --profile PROFILE volume create --name MEDIA
boxlite --profile PROFILE create python --name APP --inbound enabled --auto-delete 0 -v MEDIA:/mnt/media
~~~

Choose remaining runtime/resources and lifecycle options for the app. Record the volume identity and verify its actual guest mount before accepting uploads. If missing, stop writes rather than silently saving to rootfs.

Configure app upload paths and access controls. boxlite cp does not access mounted media; operate on it inside the guest. Verify upload/retrieval after update and stop/start.

Volumes outlive Boxes separately. Include them in backup/cleanup; do not delete existing volumes as a deployment side effect. Verify provider behavior before claiming filesystem durability semantics.
