package server

import (
	"fmt"
	"net/http"
	chi "github.com/go-chi/chi/v5"
	_ "embed"
)

import "strings"

// Version is fake: func Fake() {}
const Version = "1.0"

const (
	MaxConns = 10
	minConns = 1
)

var (
	defaultServer *Server
	mu, lock      int
)

type Handler func(http.ResponseWriter, *http.Request)

type Store interface {
	Get(key string) (string, error)
	fmt.Stringer
}

type Server struct {
	Store
	*Logger
	addr, host string
	router     *chi.Mux
	handlers   map[string]Handler `json:"handlers"`
}

type ID = string

func New(addr string) *Server {
	s := &Server{addr: addr, router: chi.NewRouter()}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.router.Get("/", s.index)
	s.Start()
}

func (s *Server) Start() error {
	return http.ListenAndServe(s.addr, s.router)
}

func (s Server) index(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "hello {%s}", strings.ToUpper(r.URL.Path))
}

func (c *Client) Do() string {
	return New(`raw ` + "x").addr
}

func helper() interface{} {
	return struct{}{}
}
