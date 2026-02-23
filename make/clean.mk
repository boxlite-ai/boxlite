PHONY_TARGETS += clean clean\:dist

clean:
	@$(SCRIPT_DIR)/clean.sh --mode all

clean\:dist:
	@$(SCRIPT_DIR)/clean.sh --mode dist
