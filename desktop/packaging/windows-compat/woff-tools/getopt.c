#include "unistd.h"

#include <stdio.h>
#include <string.h>

char *optarg = NULL;
int optind = 1;
int opterr = 1;
int optopt = 0;

int getopt(int argc, char *const argv[], const char *options) {
  static int offset = 1;
  const char *declaration;
  char *argument;

  optarg = NULL;
  if (optind >= argc) return -1;
  argument = argv[optind];
  if (argument[0] != '-' || argument[1] == '\0') return -1;
  if (strcmp(argument, "--") == 0) {
    optind += 1;
    offset = 1;
    return -1;
  }

  optopt = (unsigned char)argument[offset];
  declaration = strchr(options, optopt);
  if (declaration == NULL || optopt == ':') {
    if (argument[++offset] == '\0') {
      optind += 1;
      offset = 1;
    }
    if (opterr) fprintf(stderr, "unknown option -- %c\n", optopt);
    return '?';
  }

  if (declaration[1] == ':') {
    if (argument[offset + 1] != '\0') {
      optarg = &argument[offset + 1];
      optind += 1;
    } else if (optind + 1 < argc) {
      optarg = argv[optind + 1];
      optind += 2;
    } else {
      optind += 1;
      if (opterr) fprintf(stderr, "option requires an argument -- %c\n", optopt);
      offset = 1;
      return options[0] == ':' ? ':' : '?';
    }
    offset = 1;
  } else if (argument[++offset] == '\0') {
    optind += 1;
    offset = 1;
  }
  return optopt;
}
