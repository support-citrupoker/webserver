import './styles/main.css'
import React, { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import Infospace from './infospace'
import Pricetracker from './pricetracker'

export default function Home () {
  useEffect(() => {

  })
  return (
    <div id='feed-scroll' class='parallax'>
      <div class='parallax__layer parallax__layer__0' />
      <div class='parallax__layer parallax__layer__1' />
      <div class='parallax__layer parallax__layer__2' />
      <div class='parallax__layer parallax__layer__3' />
      <div class='parallax__layer parallax__layer__4' />
      <div class='parallax__layer parallax__layer__5' />
      <div class='parallax__layer parallax__layer__6'>

       <h1>Hello World.</h1>

      </div>
      <div class='parallax__cover border-t-4 border-white'>
        <div class='flex justify-center'>
          <header class='w-5/6 mt-5 text-white  bg-black/50 rounded-full shadow-sm body-font'>
            <div class='container flex flex-row items-start p-1 md:p-4 mx-auto md:flex-row items-center'>
              <a class='flex honkHeading hidden md:block text-2xl items-center text-white font-black text-gray-900 title-font md:mb-0'>
                BLSH
              </a>
              <nav class='flex items-center justify-center text-base ml-4 md:ml-auto'>
                <NavLink end to='/' className='text-xs md:text-base mr-5 font-medium text-white hover:underline'>Home</NavLink>
                <NavLink end to='/about' className='text-xs md:text-base mr-5 font-medium text-white hover:underline'>About</NavLink>
              </nav>
              <div class='items-center h-full pl-2 md:pl-6 md:ml-6 border-l border-gray-200'>
                <NavLink end to='/login' className='text-xs md:text-base mr-5 font-medium text-white hover:underline'>Login</NavLink>
                <NavLink end to='/signup' className='text-xs md:text-base px-2 py-1 md:px-4 md:py-2 text-xs font-bold text-white hover:bg-gray-300 uppercase transition-all duration-150 bg-teal-500 rounded-full shadow outline-none active:bg-teal-600 hover:shadow-md focus:outline-none ease'>Sign Up</NavLink>
              </div>
            </div>
          </header>
        </div>
        <Infospace />
      </div>

    </div>
  )
}
