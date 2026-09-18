test\:apps\:referral\:unit test\:apps\:referral\:dashboard check\:apps\:referral generate\:apps\:referral typecheck\:apps\:referral format\:apps\:referral:
	@node apps/scripts/referral.mjs $(if $(filter test:%,$@),$(lastword $(subst :, ,$@)),$(firstword $(subst :, ,$@)))
