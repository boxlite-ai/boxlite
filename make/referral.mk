test\:apps\:referral\:unit test\:apps\:referral\:integration test\:apps\:referral\:dashboard test\:apps\:referral\:browser test\:apps\:referral\:acceptance check\:apps\:referral generate\:apps\:referral typecheck\:apps\:referral format\:apps\:referral:
	@node apps/scripts/referral.mjs $(if $(filter test:%,$@),$(lastword $(subst :, ,$@)),$(firstword $(subst :, ,$@)))
