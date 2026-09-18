test\:apps\:referral\:unit check\:apps\:referral generate\:apps\:referral typecheck\:apps\:referral format\:apps\:referral:
	@node apps/scripts/referral.mjs $(if $(filter test:%,$@),$(lastword $(subst :, ,$@)),$(firstword $(subst :, ,$@)))
